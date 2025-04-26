const { getSupabaseWithToken } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
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
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);

    // Fetch all expenses for the user
    const { data: expenses, error: fetchError } = await supabase.from("expenses").select("date, grand_total").eq("user_id", user.id);

    if (fetchError) {
      return res.status(500).json({ error: true, message: "Failed to fetch expenses: " + fetchError.message });
    }

    // Process grand_total
    const monthlyTotal = expenses
      .filter((expense) => {
        const expenseDate = new Date(expense.date);
        return expenseDate >= startOfMonth && expenseDate <= endOfMonth;
      })
      .reduce((sum, expense) => sum + (expense.grand_total || 0), 0);

    const last30DaysTotal = expenses
      .filter((expense) => {
        const expenseDate = new Date(expense.date);
        return expenseDate >= thirtyDaysAgo && expenseDate <= today;
      })
      .reduce((sum, expense) => sum + (expense.grand_total || 0), 0);

    return res.status(200).json({
      error: false,
      data: {
        monthly_total: monthlyTotal,
        last_30_days_total: last30DaysTotal,
      },
    });
  } catch (err) {
    console.error("[SUMMARY EXPENSE ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
