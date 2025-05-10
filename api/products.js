const { getSupabaseWithToken } = require("../lib/supabaseClient");

module.exports = async (req, res) => {
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

        const { category, name, total_stock, min_stock, unit, buy_price, status } = req.body;

        if (!category || !name || total_stock === undefined || min_stock === undefined || !unit || buy_price === undefined || !status) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const prefix = 1000;

        const { data: latestProduct, error: fetchError } = await supabase.from("products").select("number").gte("number", prefix).order("number", { ascending: false }).limit(1);

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest product number: " + fetchError.message });
        }

        let counter = 1;
        if (latestProduct && latestProduct.length > 0) {
          const lastNumber = latestProduct[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
          counter = lastCounter + 1;
        }

        const newNumber = prefix + counter;

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

        const { name, location, total_stock } = req.body;

        if (!name || !location || total_stock === undefined) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const prefix = 1000;

        const { data: latestWarehouse, error: fetchError } = await supabase.from("warehouses").select("number").gte("number", prefix).order("number", { ascending: false }).limit(1);

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest warehouse number: " + fetchError.message });
        }

        let counter = 1;
        if (latestWarehouse && latestWarehouse.length > 0) {
          const lastNumber = latestWarehouse[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
          counter = lastCounter + 1;
        }

        const newNumber = prefix + counter;

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

        const tableName = action === "getProducts" ? "products" : "warehouses";
        const filterField = action === "getProducts" ? "category" : "location";
        const filterValue = req.query[filterField];
        const limit = parseInt(req.query.limit) || 10;

        let query = supabase.from(tableName).select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(limit);

        if (filterValue) {
          query = query.eq(filterField, filterValue);
        }

        const { data, error: fetchError } = await query;
        if (fetchError) {
          return res.status(500).json({ error: true, message: `Failed to fetch ${tableName}: ${fetchError.message}` });
        }

        return res.status(200).json({ error: false, data });
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
