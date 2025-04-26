const { getSupabaseWithToken } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
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

    const { type, date, orders_date, due_date, status, tags, items } = req.body;

    if (!date || !items || items.length === 0) {
      return res.status(400).json({
        error: true,
        message: "Date and at least one item are required",
      });
    }

    // Fetch latest order number
    const { data: latestOrder, error: fetchError } = await supabase.from("orders").select("number").order("number", { ascending: true }).limit(1).single();

    if (fetchError && fetchError.code !== "PGRST116") {
      return res.status(500).json({ error: true, message: "Failed to fetch latest order number: " + fetchError.message });
    }

    let nextNumber = "1"; // default
    if (latestOrder && latestOrder.number !== undefined && latestOrder.number !== null) {
      const lastNumberInt = parseInt(latestOrder.number, 10);
      nextNumber = lastNumberInt + 1;
    }

    const updatedItems = items.map((item) => {
      const qty = Number(item.qty) || 0;
      const unit_price = Number(item.price) || 0;
      const total_per_item = qty * unit_price;

      return {
        ...item,
        total_per_item,
      };
    });

    // Final grand total
    const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

    const { error } = await supabase.from("orders").insert([
      {
        user_id: user.id,
        type,
        date,
        number: nextNumber,
        orders_date,
        due_date,
        status,
        tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
        items: updatedItems,
        grand_total,
      },
    ]);

    if (error) {
      return res.status(500).json({
        error: true,
        message: "Failed to create order: " + error.message,
      });
    }

    return res.status(201).json({
      error: false,
      message: "Order created successfully",
    });
  } catch (err) {
    console.error("[Order ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
