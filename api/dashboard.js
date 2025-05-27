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
  let body = {};
  if (req.method !== "GET") {
    try {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const rawBody = Buffer.concat(buffers).toString();
      body = JSON.parse(rawBody);
    } catch (err) {
      console.error("Error parsing JSON:", err.message);
      return res.status(400).json({ error: true, message: "Invalid JSON body" });
    }
  }

  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
      // Summary Finance Endpoint
      case "summaryFinance": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for summaryFinance." });
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

        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const previousMonthStart = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
        const previousMonthEnd = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0);

        // Get data from sales
        const { data: sales, error: salesError } = await supabase.from("sales").select("invoice_date, grand_total");

        if (salesError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sales: " + salesError.message });
        }

        // Get data from bank_receive_transactions
        const { data: payments, error: paymentsError } = await supabase.from("bank_receive_transactions").select("date_received, amount");

        if (paymentsError) {
          return res.status(500).json({ error: true, message: "Failed to fetch payment transactions: " + paymentsError.message });
        }

        // Calculate the total sales dan payments
        const totalSalesCurrentMonth = sales
          .filter((sale) => {
            const d = new Date(sale.invoice_date);
            return d >= currentMonthStart && d <= currentMonthEnd;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const totalSalesPreviousMonth = sales
          .filter((sale) => {
            const d = new Date(sale.invoice_date);
            return d >= previousMonthStart && d <= previousMonthEnd;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const paymentsCurrentMonth = payments
          .filter((p) => {
            const d = new Date(p.date_received);
            return d >= currentMonthStart && d <= currentMonthEnd;
          })
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        const paymentsPreviousMonth = payments
          .filter((p) => {
            const d = new Date(p.date_received);
            return d >= previousMonthStart && d <= previousMonthEnd;
          })
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            total_sales_current_month: totalSalesCurrentMonth,
            total_sales_previous_month: totalSalesPreviousMonth,
            payments_received_current_month: paymentsCurrentMonth,
            payments_received_previous_month: paymentsPreviousMonth,
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
