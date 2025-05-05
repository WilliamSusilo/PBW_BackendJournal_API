const { getSupabaseWithToken } = require("../lib/supabaseClient");

module.exports = async (req, res) => {
  const { method, query } = req;
  const body = req.body;
  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
      // Add Sales Endpoint
      case "addSale": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addSale." });
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

        const { customer_name, invoice_date, due_date, status, items } = req.body;

        if (!customer_name || !invoice_date || !due_date || !status || !items || items.length === 0) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const invoiceDate = new Date(invoice_date);
        const month = invoiceDate.getMonth() + 1;
        const year = invoiceDate.getFullYear();

        const prefix = `${year}${String(month).padStart(2, "0")}`;
        const prefixInt = parseInt(prefix + "0", 10);
        const nextPrefixInt = parseInt(prefix + "9999", 10);

        const { data: latestSale, error: fetchError } = await supabase.from("sales").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest sale number: " + fetchError.message });
        }

        let counter = 1;
        if (latestSale && latestSale.length > 0) {
          const lastNumber = latestSale[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
          counter = lastCounter + 1;
        }

        const nextInvoiceNumber = parseInt(`${prefix}${counter}`, 10);

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.unit_price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error: insertError } = await supabase.from("sales").insert([
          {
            user_id: user.id,
            number: nextInvoiceNumber,
            customer_name,
            invoice_date,
            due_date,
            status,
            items: updatedItems,
            grand_total,
          },
        ]);

        if (insertError) return res.status(500).json({ error: true, message: "Failed to create sale: " + insertError.message });

        return res.status(201).json({ error: false, message: "Sale created successfully" });
      }

      // Delete Sale Endpoint
      case "deleteSale": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteSale." });
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
        } = await supabase.auth.getUser(token);

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Sale ID is required" });
        }

        const { data: sale, error: fetchError } = await supabase.from("sales").select("id").eq("id", id);

        if (fetchError || !sale || sale.length === 0) {
          return res.status(404).json({ error: true, message: "Sale not found" });
        }

        const { error: deleteError } = await supabase.from("sales").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete sale: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Sale deleted successfully" });
      }

      // Get Sale Endpoint
      case "getSale": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getSale." });
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

        let query = supabase.from("sales").select("*").eq("user_id", user.id);

        query = query.order("date", { ascending: false });

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch sales: " + error.message });

        const formattedData = data.map((expense) => ({
          ...expense,
          number: `Sales Invoice #${String(expense.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
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
