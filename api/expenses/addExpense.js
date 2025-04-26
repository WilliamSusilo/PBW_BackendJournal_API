const { getSupabaseWithToken } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
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

    const { date, category, beneficiary, status, items } = req.body;
    if (!date || !category || !beneficiary || !status || !items || items.length === 0) {
      return res.status(400).json({ error: true, message: "Missing required fields" });
    }

    const { data: latestExpense, error: fetchError } = await supabase.from("expenses").select("number").order("number", { ascending: true }).limit(1).single();

    if (fetchError && fetchError.code !== "PGRST116") {
      return res.status(500).json({ error: true, message: "Failed to fetch latest expense number: " + fetchError.message });
    }

    let nextNumber = "1"; // default
    if (latestExpense && latestExpense.number !== undefined && latestExpense.number !== null) {
      const lastNumberInt = parseInt(latestExpense.number, 10);
      nextNumber = lastNumberInt + 1;
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

    const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

    const { error: insertError } = await supabase.from("expenses").insert([
      {
        user_id: user.id,
        number: nextNumber,
        date,
        category,
        beneficiary,
        status,
        items: updatedItems,
        grand_total,
      },
    ]);

    if (insertError) return res.status(500).json({ error: true, message: "Failed to create expense: " + insertError.message });

    return res.status(201).json({ error: false, message: "Expense created successfuly" });
  } catch (err) {
    console.error("[CREATE EXPENSE ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
