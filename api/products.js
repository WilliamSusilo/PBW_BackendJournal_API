const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE"],
  origin: ["http://localhost:8080", "https://prabaraja-webapp.vercel.app"],
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

        const { category, name, total_stock, min_stock, unit, buy_price, status } = req.body;

        if (!category || !name || total_stock === undefined || min_stock === undefined || !unit || buy_price === undefined || !status) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const allowedStatuses = ["In Stock", "Out of Stock"];
        if (!allowedStatuses.includes(status)) {
          return res.status(400).json({ error: true, message: `Invalid status. Allowed values: ${allowedStatuses.join(", ")}` });
        }

        const { data: maxNumberData, error: fetchError } = await supabase.from("products").select("number").order("number", { ascending: false }).limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest product number: " + fetchError.message });
        }

        let newNumber = 1;
        if (maxNumberData && maxNumberData.length > 0) {
          newNumber = maxNumberData[0].number + 1;
        }

        const { error: insertError } = await supabase.from("products").insert([
          {
            user_id: user.id,
            number: newNumber,
            category,
            name,
            total_stock: Number(total_stock),
            min_stock: Number(min_stock),
            unit,
            buy_price: Number(buy_price),
            status,
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

        const { name, location, total_stock } = req.body;

        if (!name || !location || total_stock === undefined) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
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
            location,
            total_stock: Number(total_stock),
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to add warehouse: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Warehouse added successfully" });
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

        const { id, category, name, total_stock, min_stock, unit, buy_price, status } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const allowedStatuses = ["In Stock", "Out of Stock"];
        if (!allowedStatuses.includes(status)) {
          return res.status(400).json({ error: true, message: `Invalid status. Allowed values: ${allowedStatuses.join(", ")}` });
        }

        const { data: existingProduct, error: fetchError } = await supabase.from("products").select("id").eq("id", id);

        if (fetchError || !existingProduct || existingProduct.length === 0) {
          return res.status(404).json({ error: true, message: "Product not found or does not belong to user" });
        }

        const { error: updateError } = await supabase
          .from("products")
          .update({
            category,
            name,
            total_stock: Number(total_stock),
            min_stock: Number(min_stock),
            unit,
            buy_price: Number(buy_price),
            status,
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

        const { id, name, location, total_stock } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const { error: updateError } = await supabase
          .from("warehouses")
          .update({
            name,
            location,
            total_stock: Number(total_stock),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update warehouse: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Warehouse updated successfully" });
      }

      // Delete Product, Warehouse Endpoint
      case "deleteProduct":
      case "deleteWarehouse": {
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
          return res.status(400).json({ error: true, message: `${action === "deleteProduct" ? "Product" : "Warehouse"} ID is required` });
        }

        const tableName = action === "deleteProduct" ? "products" : "warehouses";
        const entityName = action === "deleteProduct" ? "Product" : "Warehouse";

        const { data: record, error: fetchError } = await supabase.from(tableName).select("id").eq("id", id);

        if (fetchError || !record || record.length === 0) {
          return res.status(404).json({ error: true, message: `${entityName} not found` });
        }

        const { error: deleteError } = await supabase.from(tableName).delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: `Failed to delete ${entityName.toLowerCase()}: ` + deleteError.message });
        }

        return res.status(200).json({ error: false, message: `${entityName} deleted successfully` });
      }

      // Get All Products, Warehouses Endpoint
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

        const tableName = action === "getProducts" ? "products" : "warehouses";
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
          const stringColumns = action === "getProducts" ? ["category", "name", "unit", "status"] : ["name", "location"];

          const intColumns = action === "getProducts" ? ["total_stock", "min_stock"] : ["total_stock"];

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

        const formattedData = data.map((item) => ({
          ...item,
          number: `${prefix}${String(item.number).padStart(3, "0")}`,
        }));

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
