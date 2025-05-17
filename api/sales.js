const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PATCH", "DELETE"],
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

        const { customer_name, invoice_date, due_date, status, items, grand_total } = req.body;

        if (!customer_name || !invoice_date || !due_date || !status || !items || items.length === 0 || !grand_total) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const invoiceDate = new Date(invoice_date);
        const month = invoiceDate.getMonth() + 1;
        const year = invoiceDate.getFullYear();

        const prefix = `${year}${String(month).padStart(2, "0")}`;

        const { data: latestSale, error: fetchError } = await supabase
          .from("sales")
          .select("number")
          .gte("invoice_date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("invoice_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest sale number: " + fetchError.message });
        }

        let counter = 1;
        if (latestSale && latestSale.length > 0) {
          const lastNumber = latestSale[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
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

        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

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

      // Edit Sales Endpoint
      case "editSale": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editSale." });
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

        const { id, customer_name, invoice_date, due_date, status, items, grand_total } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.unit_price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        const { error: updateError } = await supabase
          .from("sales")
          .update({
            customer_name,
            invoice_date,
            due_date,
            status,
            items: updatedItems,
            grand_total,
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update sale: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Sale updated successfully" });
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

        const { status } = req.query;
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("sales").select("*").order("invoice_date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["customer_name"];
          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("grand_total.eq." + parseFloat(search));
          }

          // For detect search like "Sales Invoice #00588"
          const codeMatch = search.match(/^sales invoice\s?#?0*(\d{7,})$/i);
          if (codeMatch) {
            const extractedNumber = parseInt(codeMatch[1], 10);
            if (!isNaN(extractedNumber)) {
              eqIntConditions.push("number.eq." + extractedNumber);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch sales: " + error.message });

        const formattedData = data.map((sale) => ({
          ...sale,
          number: `Sales Invoice #${String(sale.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      //   Summary Sales Endpoint
      case "summarySale": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for summarySale." });
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

        const today = new Date();
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);

        // Fetch all sales for the user
        const { data: sales, error: fetchError } = await supabase.from("sales").select("invoice_date, grand_total, status");

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sales: " + fetchError.message });
        }

        // Process grand_total
        const unpaidTotal = sales
          .filter((sale) => {
            return sale.status === "Unpaid";
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const last30DaysTotal = sales
          .filter((sale) => {
            const saleDate = new Date(sale.invoice_date);
            return saleDate >= thirtyDaysAgo && saleDate <= today;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            unpaid_total: unpaidTotal,
            last_30_days_total: last30DaysTotal,
          },
        });
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
