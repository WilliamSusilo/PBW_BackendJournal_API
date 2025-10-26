const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE"],
  origin: ["http://localhost:8080", "http://192.168.100.3:8080", "https://prabaraja-webapp.vercel.app", "https://prabaraja-project.vercel.app"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// Helper for run middleware with async
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

// Helper to round numeric values to 2 decimal places but keep them as numbers (not strings)
const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// Helper to ensure warehouse exists, auto-create if not
// Supports both single string and array of warehouse names
async function ensureWarehouseExists(supabase, userId, warehouseInput) {
  // Normalize input to array
  let warehouseNames = [];

  if (typeof warehouseInput === "string") {
    warehouseNames = [warehouseInput];
  } else if (Array.isArray(warehouseInput)) {
    warehouseNames = warehouseInput.filter((name) => name && typeof name === "string");
  } else {
    return { success: false, error: "Invalid warehouse input: must be string or array of strings" };
  }

  if (warehouseNames.length === 0) {
    return { success: false, error: "No valid warehouse names provided" };
  }

  const results = [];
  const createdWarehouses = [];

  for (const warehouseName of warehouseNames) {
    // Check if warehouse already exists
    const { data: existingWarehouse, error: checkError } = await supabase.from("warehouses").select("id, name").eq("user_id", userId).eq("name", warehouseName).maybeSingle();

    if (checkError) {
      return { success: false, error: "Failed to check existing warehouse: " + checkError.message };
    }

    // If warehouse exists, add to results
    if (existingWarehouse) {
      results.push({ existed: true, warehouse: existingWarehouse });
      continue;
    }

    // Auto-create new warehouse
    const { data: maxNumberData, error: fetchError } = await supabase.from("warehouses").select("number").order("number", { ascending: false }).limit(1);

    if (fetchError) {
      return { success: false, error: "Failed to fetch latest warehouse number: " + fetchError.message };
    }

    let newNumber = 1;
    if (maxNumberData && maxNumberData.length > 0) {
      newNumber = maxNumberData[0].number + 1;
    }

    const { data: newWarehouse, error: insertError } = await supabase
      .from("warehouses")
      .insert([
        {
          user_id: userId,
          number: newNumber,
          name: warehouseName,
          location: null,
          total_stock: 0,
          created_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (insertError) {
      return { success: false, error: "Failed to auto-create warehouse: " + insertError.message };
    }

    results.push({ existed: false, warehouse: newWarehouse });
    createdWarehouses.push(warehouseName);
  }

  return {
    success: true,
    results,
    createdWarehouses,
    allExisted: createdWarehouses.length === 0,
  };
}

// Helper to update total_stock for warehouse(s)
async function updateWarehouseTotalStock(supabase, userId, warehouseInput) {
  // Normalize input to array
  let warehouseNames = [];

  if (typeof warehouseInput === "string") {
    warehouseNames = [warehouseInput];
  } else if (Array.isArray(warehouseInput)) {
    warehouseNames = warehouseInput.filter((name) => name && typeof name === "string");
  }

  for (const warehouseName of warehouseNames) {
    // Get all stocks for this warehouse
    const { data: allStocks, error: stockError } = await supabase.from("stock").select("*").eq("user_id", userId);

    if (stockError) {
      console.error(`Error fetching stocks for warehouse ${warehouseName}:`, stockError);
      continue;
    }

    // Count stocks that include this warehouse
    const stockCount = (allStocks || []).filter((stock) => {
      if (typeof stock.warehouses === "string") {
        return stock.warehouses === warehouseName;
      } else if (Array.isArray(stock.warehouses)) {
        return stock.warehouses.includes(warehouseName);
      }
      return false;
    }).length;

    // Update warehouse total_stock
    await supabase.from("warehouses").update({ total_stock: stockCount, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("name", warehouseName);
  }
}

module.exports = async (req, res) => {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { method, query } = req;
  const body = req.body;
  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
      // === ADD BILL OF MATERIAL ENDPOINT ===
      case "addBillOfMaterial": {
        if (method !== "POST") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for addBillOfMaterial.",
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header provided" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        // === GET USER ===
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        // === BODY INPUT ===
        const { bom_name, sku, qty_goods_est, category, est_compl_time, job_order_product, processes = [] } = req.body;

        // === VALIDATION ===
        if (!bom_name || !sku || qty_goods_est === undefined || !category || !est_compl_time || !Array.isArray(processes) || processes.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Missing required fields or empty processes array",
          });
        }

        // Helpers to ensure numeric ops are safe
        const toNum = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
        const safeDiv = (num, den) => (toNum(den) ? toNum(num) / toNum(den) : 0);

        // ============================
        //  PROCESS EACH PROCESS IN ARRAY
        // ============================
        const processedProcesses = processes.map((proc) => {
          const { process_name, job_desc, direct_material = [], direct_labor = [], indirect_material = [], indirect_labor = [], items_depreciation = [], utilities_cost = [], other_foc = [] } = proc;

          // 1. DIRECT MATERIAL
          const calcDirectMaterial = (Array.isArray(direct_material) ? direct_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_direct_material = calcDirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 2. DIRECT LABOR
          const calcDirectLabor = (Array.isArray(direct_labor) ? direct_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_direct_labor = calcDirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 3. INDIRECT MATERIAL
          const calcIndirectMaterial = (Array.isArray(indirect_material) ? indirect_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_indirect_material = calcIndirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 4. INDIRECT LABOR
          const calcIndirectLabor = (Array.isArray(indirect_labor) ? indirect_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_indirect_labor = calcIndirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 5. ITEMS DEPRECIATION
          const calcItemsDep = (Array.isArray(items_depreciation) ? items_depreciation : []).map((i) => {
            const book_value = toNum(i.qty) * toNum(i.price) - toNum(i.acc_dep);
            const est_useful_total = toNum(i.operatingday_per_month) * toNum(i.operatinghours_per_day) * 12 * toNum(i.est_useful);
            const dep_per_hours = safeDiv(book_value - toNum(i.salvage_value), est_useful_total);
            const rate_estimated = dep_per_hours * toNum(i.order_compl_time);
            return { ...i, book_value, est_useful_total, dep_per_hours, rate_estimated };
          });
          const total_items_depreciation = calcItemsDep.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 6. UTILITIES COST
          const calcUtilities = (Array.isArray(utilities_cost) ? utilities_cost : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_utilities_cost = calcUtilities.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 7. OTHER FOC
          const calcOtherFOC = (Array.isArray(other_foc) ? other_foc : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_other_foc = calcOtherFOC.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // PROCESS TOTALS
          const process_total_foc = toNum(total_indirect_material) + toNum(total_indirect_labor) + toNum(total_items_depreciation) + toNum(total_utilities_cost) + toNum(total_other_foc);
          const process_total_cogm = toNum(total_direct_material) + toNum(total_direct_labor) + toNum(process_total_foc);

          return {
            process_name,
            job_desc,
            direct_material: calcDirectMaterial,
            direct_labor: calcDirectLabor,
            indirect_material: calcIndirectMaterial,
            indirect_labor: calcIndirectLabor,
            items_depreciation: calcItemsDep,
            utilities_cost: calcUtilities,
            other_foc: calcOtherFOC,
            total_direct_material,
            total_direct_labor,
            total_indirect_material,
            total_indirect_labor,
            total_items_depreciation,
            total_utilities_cost,
            total_other_foc,
            process_total_foc,
            process_total_cogm,
          };
        });

        // ============================
        //  AGGREGATE TOTALS FROM ALL PROCESSES
        // ============================
        const total_foc_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_foc), 0);
        const total_cogm_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_cogm), 0);
        const cogm_unit_est = safeDiv(total_cogm_est, toNum(qty_goods_est));

        // Additional BOM-level aggregates per cost category (sum of all processes)
        const agg_total_direct_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_material), 0);
        const agg_total_direct_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_labor), 0);
        const agg_total_indirect_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_material), 0);
        const agg_total_indirect_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_labor), 0);
        const agg_total_items_depreciation = processedProcesses.reduce((sum, p) => sum + toNum(p.total_items_depreciation), 0);
        const agg_total_utilities_cost = processedProcesses.reduce((sum, p) => sum + toNum(p.total_utilities_cost), 0);
        const agg_total_other_foc = processedProcesses.reduce((sum, p) => sum + toNum(p.total_other_foc), 0);

        // ============================
        //  INSERT TO DATABASE
        // ============================
        const { error: insertErr } = await supabase.from("bill_of_material").insert([
          {
            user_id: user.id,
            bom_name,
            sku,
            qty_goods_est: toNum(qty_goods_est),
            category,
            est_compl_time: toNum(est_compl_time),
            job_order_product: !!job_order_product,
            processes: processedProcesses,
            total_foc_est,
            total_cogm_est,
            cogm_unit_est,
            total_direct_material: round2(agg_total_direct_material),
            total_direct_labor: round2(agg_total_direct_labor),
            total_indirect_material: round2(agg_total_indirect_material),
            total_indirect_labor: round2(agg_total_indirect_labor),
            total_items_depreciation: round2(agg_total_items_depreciation),
            total_utilities_cost: round2(agg_total_utilities_cost),
            total_other_foc: round2(agg_total_other_foc),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ]);

        if (insertErr) {
          return res.status(500).json({
            error: true,
            message: "Failed to insert Bill of Material: " + insertErr.message,
          });
        }

        return res.status(201).json({
          error: false,
          message: "Bill of Material added successfully",
          data: {
            bom_name,
            total_foc_est: round2(total_foc_est),
            total_cogm_est: round2(total_cogm_est),
            cogm_unit_est: round2(cogm_unit_est),
          },
        });
      }

      // Add Stock Endpoint
      case "addStock": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addStock." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

        const { name, sku, category, unit, minimum_stock, warehouses, stock_COA, description, copyToProduct = false } = req.body;

        if (!name || !sku || !category || !unit || minimum_stock === undefined || !warehouses || !stock_COA || !description) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        // Auto-create warehouse(s) if they don't exist
        const warehouseResult = await ensureWarehouseExists(supabase, user.id, warehouses);
        if (!warehouseResult.success) {
          return res.status(500).json({ error: true, message: warehouseResult.error });
        }

        // Insert new stock
        const { error: insertStockError, data: insertedStock } = await supabase
          .from("stock")
          .insert([
            {
              user_id: user.id,
              name,
              sku,
              category,
              unit,
              minimum_stock: Number(minimum_stock),
              warehouses,
              stock_COA,
              description,
              copyToProduct,
              created_at: new Date().toISOString(),
            },
          ])
          .select("*")
          .single();

        if (insertStockError) {
          return res.status(500).json({ error: true, message: "Failed to add stock: " + insertStockError.message });
        }

        // Update total_stock for all affected warehouses
        await updateWarehouseTotalStock(supabase, user.id, warehouses);

        // Build response message
        let responseMessage = "Stock added successfully";
        if (warehouseResult.createdWarehouses && warehouseResult.createdWarehouses.length > 0) {
          const createdList = warehouseResult.createdWarehouses.map((w) => `"${w}"`).join(", ");
          responseMessage += ` (Warehouse${warehouseResult.createdWarehouses.length > 1 ? "s" : ""} ${createdList} auto-created)`;
        }

        // Only insert to products if copyToProduct = true
        if (copyToProduct === true) {
          // Get the latest total_cogs data from inventory
          const { data: latestInventory, error: inventoryError } = await supabase.from("inventory").select("total_cogs").order("updated_at", { ascending: false }).limit(1).single();

          if (inventoryError) {
            return res.status(404).json({ error: true, message: "Total COGS data not found" });
          }

          const { error: insertProductError } = await supabase.from("products").insert([
            {
              user_id: user.id,
              name,
              sku,
              category,
              unit,
              warehouses,
              company_type: "Merchandise or Manufacturing",
              items_product: {
                stock_COA,
                stock_name: name,
                sell_price: null,
                cogs: latestInventory?.total_cogs || 0,
              },
              created_at: new Date().toISOString(),
            },
          ]);

          if (insertProductError) {
            return res.status(500).json({ error: true, message: "Failed to insert data to product: " + insertProductError.message });
          }
        }

        return res.status(201).json({ error: false, message: responseMessage, data: { id: insertedStock.id } });
      }

      // === EDIT BILL OF MATERIAL ENDPOINT ===
      case "editBillOfMaterial": {
        if (method !== "PUT") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use PUT for editBillOfMaterial.",
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header provided" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        const { id, bom_name, sku, qty_goods_est, category, est_compl_time, job_order_product, processes = [] } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required field: id" });
        }

        const toNum = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
        const safeDiv = (num, den) => (toNum(den) ? toNum(num) / toNum(den) : 0);

        // ============================
        //  PROCESS EACH PROCESS IN ARRAY
        // ============================
        const processedProcesses = processes.map((proc) => {
          const { process_name, job_desc, direct_material = [], direct_labor = [], indirect_material = [], indirect_labor = [], items_depreciation = [], utilities_cost = [], other_foc = [] } = proc;

          // 1. DIRECT MATERIAL
          const calcDirectMaterial = (Array.isArray(direct_material) ? direct_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_direct_material = calcDirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 2. DIRECT LABOR
          const calcDirectLabor = (Array.isArray(direct_labor) ? direct_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_direct_labor = calcDirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 3. INDIRECT MATERIAL
          const calcIndirectMaterial = (Array.isArray(indirect_material) ? indirect_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_indirect_material = calcIndirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 4. INDIRECT LABOR
          const calcIndirectLabor = (Array.isArray(indirect_labor) ? indirect_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_indirect_labor = calcIndirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 5. ITEMS DEPRECIATION
          const calcItemsDep = (Array.isArray(items_depreciation) ? items_depreciation : []).map((i) => {
            const book_value = toNum(i.qty) * toNum(i.price) - toNum(i.acc_dep);
            const est_useful_total = toNum(i.operatingday_per_month) * toNum(i.operatinghours_per_day) * 12 * toNum(i.est_useful);
            const dep_per_hours = safeDiv(book_value - toNum(i.salvage_value), est_useful_total);
            const rate_estimated = dep_per_hours * toNum(i.order_compl_time);
            return { ...i, book_value, est_useful_total, dep_per_hours, rate_estimated };
          });
          const total_items_depreciation = calcItemsDep.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 6. UTILITIES COST
          const calcUtilities = (Array.isArray(utilities_cost) ? utilities_cost : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_utilities_cost = calcUtilities.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 7. OTHER FOC
          const calcOtherFOC = (Array.isArray(other_foc) ? other_foc : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_other_foc = calcOtherFOC.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // PROCESS TOTALS
          const process_total_foc = toNum(total_indirect_material) + toNum(total_indirect_labor) + toNum(total_items_depreciation) + toNum(total_utilities_cost) + toNum(total_other_foc);
          const process_total_cogm = toNum(total_direct_material) + toNum(total_direct_labor) + toNum(process_total_foc);

          return {
            process_name,
            job_desc,
            direct_material: calcDirectMaterial,
            direct_labor: calcDirectLabor,
            indirect_material: calcIndirectMaterial,
            indirect_labor: calcIndirectLabor,
            items_depreciation: calcItemsDep,
            utilities_cost: calcUtilities,
            other_foc: calcOtherFOC,
            total_direct_material,
            total_direct_labor,
            total_indirect_material,
            total_indirect_labor,
            total_items_depreciation,
            total_utilities_cost,
            total_other_foc,
            process_total_foc,
            process_total_cogm,
          };
        });

        // ============================
        //  AGGREGATE TOTALS FROM ALL PROCESSES
        // ============================
        const total_foc_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_foc), 0);
        const total_cogm_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_cogm), 0);
        const cogm_unit_est = safeDiv(total_cogm_est, toNum(qty_goods_est));

        // Additional BOM-level aggregates per cost category (sum of all processes)
        const agg_total_direct_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_material), 0);
        const agg_total_direct_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_labor), 0);
        const agg_total_indirect_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_material), 0);
        const agg_total_indirect_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_labor), 0);
        const agg_total_items_depreciation = processedProcesses.reduce((sum, p) => sum + toNum(p.total_items_depreciation), 0);
        const agg_total_utilities_cost = processedProcesses.reduce((sum, p) => sum + toNum(p.total_utilities_cost), 0);
        const agg_total_other_foc = processedProcesses.reduce((sum, p) => sum + toNum(p.total_other_foc), 0);

        const { error: updateErr } = await supabase
          .from("bill_of_material")
          .update({
            user_id: user.id,
            bom_name,
            sku,
            qty_goods_est: toNum(qty_goods_est),
            category,
            est_compl_time: toNum(est_compl_time),
            job_order_product: !!job_order_product,
            processes: processedProcesses,
            total_foc_est,
            total_cogm_est,
            cogm_unit_est,
            total_direct_material: round2(agg_total_direct_material),
            total_direct_labor: round2(agg_total_direct_labor),
            total_indirect_material: round2(agg_total_indirect_material),
            total_indirect_labor: round2(agg_total_indirect_labor),
            total_items_depreciation: round2(agg_total_items_depreciation),
            total_utilities_cost: round2(agg_total_utilities_cost),
            total_other_foc: round2(agg_total_other_foc),
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateErr) {
          return res.status(500).json({ error: true, message: "Failed to update Bill of Material: " + updateErr.message });
        }

        return res.status(200).json({
          error: false,
          message: "Bill of Material updated successfully",
          data: {
            id,
            bom_name,
            total_foc_est: round2(total_foc_est),
            total_cogm_est: round2(total_cogm_est),
            cogm_unit_est: round2(cogm_unit_est),
          },
        });
      }
      // Add Product Endpoint
      case "addProduct": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addProduct." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["inventory", "procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        // Accept new fields: acc_info (text) and items_product (jsonb). For backward compatibility,
        // if items_product is not provided, build it from legacy fields: stock_COA, stock_name, sell_price, cogs.
        const {
          category,
          name,
          unit,
          sku,
          warehouses,
          description,
          sales_COA,
          cogs_COA,
          acc_info,
          items_product,
          // legacy fields (optional, used to construct items_product if items_product not provided)
          stock_COA,
          stock_name,
          sell_price,
          cogs,
        } = req.body;

        if (!category || !name || !unit || !sku || !warehouses || !description || !sales_COA || !cogs_COA) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const itemsProductPayload =
          items_product && typeof items_product === "object"
            ? {
                stock_COA: items_product.stock_COA ?? null,
                stock_name: items_product.stock_name ?? null,
                sell_price: items_product.sell_price != null ? Number(items_product.sell_price) : null,
                cogs: items_product.cogs != null ? Number(items_product.cogs) : null,
              }
            : {
                stock_COA: stock_COA ?? null,
                stock_name: stock_name ?? null,
                sell_price: sell_price != null ? Number(sell_price) : null,
                cogs: cogs != null ? Number(cogs) : null,
              };

        // Ensure all required items_product fields are present (not null/undefined)
        const requiredItemKeys = ["stock_COA", "stock_name", "sell_price", "cogs"];
        const hasAllItemFields = requiredItemKeys.every((k) => itemsProductPayload[k] !== null && itemsProductPayload[k] !== undefined);
        if (!hasAllItemFields) {
          return res.status(400).json({ error: true, message: "Missing required items_product fields (stock_COA, stock_name, sell_price, cogs)" });
        }

        // const allowedStatuses = ["In Stock", "Out of Stock"];
        // if (!allowedStatuses.includes(status)) {
        //   return res.status(400).json({ error: true, message: `Invalid status. Allowed values: ${allowedStatuses.join(", ")}` });
        // }

        // const { data: maxNumberData, error: fetchError } = await supabase.from("products").select("number").order("number", { ascending: false }).limit(1);

        // if (fetchError) {
        //   return res.status(500).json({ error: true, message: "Failed to fetch latest product number: " + fetchError.message });
        // }

        // let newNumber = 1;
        // if (maxNumberData && maxNumberData.length > 0) {
        //   newNumber = maxNumberData[0].number + 1;
        // }

        const { error: insertError } = await supabase.from("products").insert([
          {
            user_id: user.id,
            category,
            name,
            unit,
            sku,
            warehouses,
            description,
            sales_COA,
            cogs_COA,
            company_type: "Service",
            acc_info: acc_info ?? null,
            items_product: itemsProductPayload,
            created_at: new Date().toISOString(),
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to add product: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Product added successfully" });
      }

      // Add Warehouse Endpoint
      case "addWarehouse": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addWarehouse." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["inventory", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { name, location } = req.body;

        if (!name) {
          return res.status(400).json({ error: true, message: "Warehouse name is required" });
        }

        // Check if warehouse with this name already exists for this user
        const { data: existingWarehouse, error: checkError } = await supabase.from("warehouses").select("id, name").eq("user_id", user.id).eq("name", name).maybeSingle();

        if (checkError) {
          return res.status(500).json({ error: true, message: "Failed to check existing warehouse: " + checkError.message });
        }

        if (existingWarehouse) {
          return res.status(409).json({ error: true, message: `Warehouse with name "${name}" already exists` });
        }

        const { data: maxNumberData, error: fetchError } = await supabase.from("warehouses").select("number").order("number", { ascending: false }).limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest warehouse number: " + fetchError.message });
        }

        let newNumber = 1;
        if (maxNumberData && maxNumberData.length > 0) {
          newNumber = maxNumberData[0].number + 1;
        }

        const { error: insertError } = await supabase.from("warehouses").insert([
          {
            user_id: user.id,
            number: newNumber,
            name,
            location: location || null,
            total_stock: 0,
            created_at: new Date().toISOString(),
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to add warehouse: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Warehouse added successfully" });
      }

      // Edit Stock Endpoint
      case "editStock": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editStock." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["inventory", "procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, name, sku, category, unit, minimum_stock, warehouses, stock_COA, description, copyToProduct } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const { data: existingStock, error: fetchError } = await supabase.from("stock").select("*").eq("id", id).single();

        if (fetchError || !existingStock) {
          return res.status(404).json({ error: true, message: "Stock not found" });
        }

        // Auto-create warehouse(s) if they're being changed and don't exist
        let warehouseAutoCreated = [];
        if (warehouses) {
          const warehouseResult = await ensureWarehouseExists(supabase, user.id, warehouses);
          if (!warehouseResult.success) {
            return res.status(500).json({ error: true, message: warehouseResult.error });
          }
          warehouseAutoCreated = warehouseResult.createdWarehouses || [];
        }

        const { error: updateError } = await supabase
          .from("stock")
          .update({
            user_id: user.id,
            name,
            sku,
            category,
            unit,
            minimum_stock: Number(minimum_stock),
            warehouses,
            stock_COA,
            description,
            copyToProduct,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update stock: " + updateError.message });
        }

        // Update total_stock for both old and new warehouses
        // If warehouses changed, update both old and new warehouse total_stock
        if (warehouses && warehouses !== existingStock.warehouses) {
          await updateWarehouseTotalStock(supabase, user.id, existingStock.warehouses); // Update old warehouse
          await updateWarehouseTotalStock(supabase, user.id, warehouses); // Update new warehouse
        } else if (warehouses) {
          await updateWarehouseTotalStock(supabase, user.id, warehouses); // Update current warehouse
        }

        // Conditionally insert to products (first-time only):
        // If previous copyToProduct was unset (null/undefined/empty) AND request sets copyToProduct === true,
        // then insert a product using the same logic as addStock. If it was already set (true/false), skip insertion.
        const wasCopyToProductUnset = existingStock.copyToProduct === null || existingStock.copyToProduct === undefined || existingStock.copyToProduct === "";

        if (wasCopyToProductUnset && copyToProduct === true) {
          // Get the latest total_cogs data from inventory
          const { data: latestInventory, error: inventoryError } = await supabase.from("inventory").select("total_cogs").order("updated_at", { ascending: false }).limit(1).single();

          if (inventoryError) {
            return res.status(404).json({ error: true, message: "Total COGS data not found" });
          }

          // Use updated payload values if provided, otherwise fallback to existing stock values
          const prodName = name ?? existingStock.name;
          const prodSku = sku ?? existingStock.sku;
          const prodCategory = category ?? existingStock.category;
          const prodUnit = unit ?? existingStock.unit;
          const prodWarehouses = warehouses ?? existingStock.warehouses;
          const prodStockCOA = stock_COA ?? existingStock.stock_COA;

          const { error: insertProductError } = await supabase.from("products").insert([
            {
              user_id: user.id,
              name: prodName,
              sku: prodSku,
              category: prodCategory,
              unit: prodUnit,
              warehouses: prodWarehouses,
              company_type: "Merchandise or Manufacturing",
              items_product: {
                stock_COA: prodStockCOA,
                stock_name: prodName,
                sell_price: null,
                cogs: latestInventory?.total_cogs || 0,
              },
              created_at: new Date().toISOString(),
            },
          ]);

          if (insertProductError) {
            return res.status(500).json({ error: true, message: "Failed to insert data to product: " + insertProductError.message });
          }
        }

        // Build response message
        let responseMessage = "Stock updated successfully";
        if (warehouseAutoCreated.length > 0) {
          const createdList = warehouseAutoCreated.map((w) => `"${w}"`).join(", ");
          responseMessage += ` (Warehouse${warehouseAutoCreated.length > 1 ? "s" : ""} ${createdList} auto-created)`;
        }

        return res.status(200).json({ error: false, message: responseMessage });
      }

      // Edit Product Endpoint
      case "editProduct": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editProduct." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["inventory", "procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const {
          id,
          category,
          name,
          unit,
          sku,
          warehouses,
          description,
          sales_COA,
          cogs_COA,
          acc_info,
          items_product,
          // legacy (optional)
          stock_COA,
          stock_name,
          sell_price,
          cogs,
        } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const itemsProductPayload =
          items_product && typeof items_product === "object"
            ? {
                stock_COA: items_product.stock_COA ?? null,
                stock_name: items_product.stock_name ?? null,
                sell_price: items_product.sell_price != null ? Number(items_product.sell_price) : null,
                cogs: items_product.cogs != null ? Number(items_product.cogs) : null,
              }
            : {
                stock_COA: stock_COA ?? null,
                stock_name: stock_name ?? null,
                sell_price: sell_price != null ? Number(sell_price) : null,
                cogs: cogs != null ? Number(cogs) : null,
              };

        // const allowedStatuses = ["In Stock", "Out of Stock"];
        // if (!allowedStatuses.includes(status)) {
        //   return res.status(400).json({ error: true, message: `Invalid status. Allowed values: ${allowedStatuses.join(", ")}` });
        // }

        // const { data: existingProduct, error: fetchError } = await supabase.from("products").select("id").eq("id", id);

        // if (fetchError || !existingProduct || existingProduct.length === 0) {
        //   return res.status(404).json({ error: true, message: "Product not found or does not belong to user" });
        // }

        const { error: updateError } = await supabase
          .from("products")
          .update({
            user_id: user.id,
            category,
            name,
            unit,
            sku,
            warehouses,
            description,
            sales_COA,
            cogs_COA,
            company_type: "Service",
            acc_info: acc_info ?? null,
            items_product: itemsProductPayload,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update product: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Product updated successfully" });
      }

      // Edit Warehouse Endpoint
      case "editWarehouse": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editWarehouse." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["inventory", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, name, location } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Warehouse ID is required" });
        }

        // Check if warehouse exists
        const { data: existingWarehouse, error: fetchError } = await supabase.from("warehouses").select("*").eq("id", id).eq("user_id", user.id).single();

        if (fetchError || !existingWarehouse) {
          return res.status(404).json({ error: true, message: "Warehouse not found" });
        }

        // If name is being changed, check for duplicates
        if (name && name !== existingWarehouse.name) {
          const { data: duplicateWarehouse, error: checkError } = await supabase.from("warehouses").select("id").eq("user_id", user.id).eq("name", name).neq("id", id).maybeSingle();

          if (checkError) {
            return res.status(500).json({ error: true, message: "Failed to check duplicate warehouse: " + checkError.message });
          }

          if (duplicateWarehouse) {
            return res.status(409).json({ error: true, message: `Warehouse with name "${name}" already exists` });
          }
        }

        const { error: updateError } = await supabase
          .from("warehouses")
          .update({
            name: name ?? existingWarehouse.name,
            location: location ?? existingWarehouse.location,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update warehouse: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Warehouse updated successfully" });
      }

      // Delete Product, Warehouse, Bill of Material, Stock Endpoint
      case "deleteProduct":
      case "deleteWarehouse":
      case "deleteBillOfMaterial":
      case "deleteStock": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use DELETE for ${action}.` });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header provided" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        // // Role permissions per case
        // const permissionsMap = {
        //   deleteProduct: ["inventory", "procurement", "manager", "admin"],
        //   deleteWarehouse: ["inventory", "manager", "admin"],
        // };

        // // Get user role from database
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Determine current case
        // const currentCase = action;

        // // Get allowed roles for current action
        // const allowedRoles = permissionsMap[currentCase] || [];

        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: `Access denied. Your role (${userProfile.role}) is not authorized to perform ${currentCase}.`,
        //   });
        // }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: `${action === "deleteProduct" ? "Product" : action === "deleteWarehouse" ? "Warehouse" : action === "deleteBillOfMaterial" ? "Bill of Material" : "Stock"} ID is required`,
          });
        }

        const tableName = action === "deleteProduct" ? "products" : action === "deleteWarehouse" ? "warehouses" : action === "deleteBillOfMaterial" ? "bill_of_material" : "stock";
        const entityName = action === "deleteProduct" ? "Product" : action === "deleteWarehouse" ? "Warehouse" : action === "deleteBillOfMaterial" ? "Bill of Material" : "Stock";

        const { data: record, error: fetchError } = await supabase.from(tableName).select("*").eq("id", id);

        if (fetchError || !record || record.length === 0) {
          return res.status(404).json({ error: true, message: `${entityName} not found` });
        }

        // If deleting stock, save warehouses info before deletion to update total_stock
        let warehousesToUpdate = null;
        if (action === "deleteStock" && record[0].warehouses) {
          warehousesToUpdate = record[0].warehouses;
        }

        const { error: deleteError } = await supabase.from(tableName).delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: `Failed to delete ${entityName.toLowerCase()}: ` + deleteError.message });
        }

        // Update total_stock for affected warehouses after stock deletion
        if (action === "deleteStock" && warehousesToUpdate) {
          await updateWarehouseTotalStock(supabase, user.id, warehousesToUpdate);
        }

        return res.status(200).json({ error: false, message: `${entityName} deleted successfully` });
      }

      // Get Bill of Materials Endpoint
      case "getBillOfMaterials": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getBillOfMaterials." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header provided" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        const filterCategory = req.query.category;
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("bill_of_material").select("*").order("created_at", { ascending: false }).range(from, to);

        if (filterCategory) {
          query = query.eq("category", filterCategory);
        }

        if (search) {
          const stringColumns = ["bom_name", "sku", "category", "process_name", "job_desc"];
          const numericColumns = ["qty_goods_est", "est_compl_time", "total_foc_est", "total_cogm_est", "cogm_unit_est"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqNumericConditions = [];

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqNumericConditions.push(...numericColumns.map((col) => `${col}.eq.${parseFloat(search)}`));
          }

          const searchConditions = [...ilikeConditions, ...eqNumericConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;
        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch bill of materials: " + fetchError.message });
        }

        return res.status(200).json({ error: false, data });
      }

      // Get All Products, Warehouses Endpoint
      case "getStocks":
      case "getProducts":
      case "getWarehouses": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header provided" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        // // Role permissions per case
        // const permissionsMap = {
        //   getProducts: ["inventory", "procurement", "manager", "admin"],
        //   getWarehouses: ["inventory", "manager", "admin"],
        // };

        // // Get user role from database
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Determine current case
        // const currentCase = action;

        // // Get allowed roles for current action
        // const allowedRoles = permissionsMap[currentCase] || [];

        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: `Access denied. Your role (${userProfile.role}) is not authorized to perform ${currentCase}.`,
        //   });
        // }

        const tableName = action === "getProducts" ? "products" : action === "getStocks" ? "stock" : "warehouses";
        const filterField = action === "getProducts" ? "category" : "location";
        const prefix = action === "getProducts" ? "PRD" : "WH";
        const filterValue = req.query[filterField];
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from(tableName).select("*").order("created_at", { ascending: false }).range(from, to);

        if (filterValue) {
          query = query.eq(filterField, filterValue);
        }

        if (search) {
          const stringColumns = action === "getProducts" ? ["category", "name", "unit", "status"] : action === "getStocks" ? ["name", "sku", "category", "unit", "warehouses"] : ["name", "location"];

          const intColumns = action === "getProducts" ? ["total_stock", "min_stock"] : action === "getStocks" ? ["minimum_stock"] : ["total_stock"];

          const numericColumns = action === "getProducts" ? ["buy_price", "sell_price"] : [];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqIntConditions = [];
          const eqNumericConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push(...intColumns.map((col) => `${col}.eq.${search}`));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqNumericConditions.push(...numericColumns.map((col) => `${col}.eq.${parseFloat(search)}`));
          }

          const codeMatch = search.match(/^(PRD|WH)(\d{3,})$/i);
          if (codeMatch) {
            const codeNum = parseInt(codeMatch[2], 10); // example = PRD001 --> 1

            if (!isNaN(codeNum)) {
              eqIntConditions.push(`number.eq.${codeNum}`);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqNumericConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;
        if (fetchError) {
          return res.status(500).json({ error: true, message: `Failed to fetch ${tableName}: ${fetchError.message}` });
        }

        let formattedData = data.map((item) => ({
          ...item,
          // number: `${prefix}${String(item.number).padStart(3, "0")}`,
        }));

        // For getWarehouses, fetch stock items for each warehouse
        if (action === "getWarehouses") {
          const warehousesWithStock = await Promise.all(
            formattedData.map(async (warehouse) => {
              // Fetch stock items where warehouses field contains this warehouse name
              // Support both string and array formats
              const { data: allStocks, error: stockError } = await supabase.from("stock").select("*").eq("user_id", user.id);

              if (stockError) {
                console.error(`Error fetching stock for warehouse ${warehouse.name}:`, stockError);
                return {
                  ...warehouse,
                  stock_items: [],
                  stock_count: 0,
                };
              }

              // Filter stocks that contain this warehouse name
              // Works for both string format: "Warehouse A" and array format: ["Warehouse A", "Warehouse B"]
              const stockItems = (allStocks || []).filter((stock) => {
                if (typeof stock.warehouses === "string") {
                  return stock.warehouses === warehouse.name;
                } else if (Array.isArray(stock.warehouses)) {
                  return stock.warehouses.includes(warehouse.name);
                }
                return false;
              });

              const stockCount = stockItems.length;

              // Auto-update total_stock in database if different
              if (warehouse.total_stock !== stockCount) {
                await supabase
                  .from("warehouses")
                  .update({
                    total_stock: stockCount,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", warehouse.id);
              }

              return {
                ...warehouse,
                total_stock: stockCount, // Update total_stock dengan jumlah stock items aktual
                stock_items: stockItems,
                stock_count: stockCount,
              };
            })
          );

          formattedData = warehousesWithStock;
        }

        return res.status(200).json({ error: false, formattedData });
      }

      // Non-existent Endpoint
      default:
        return res.status(404).json({ error: true, message: "Endpoint not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: true, message: error.message || "Unexpected server error" });
  }
};
