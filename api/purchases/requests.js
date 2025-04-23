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

    const { type, date, number, requested_by, urgency, due_date, status, tags, items } = req.body;

    if (!number || !date || !items || items.length === 0) {
      return res.status(400).json({
        error: true,
        message: "Request number, date, and at least one item are required",
      });
    }

    const grand_total = items.reduce((sum, item) => {
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      return sum + qty * price;
    }, 0);

    const { error } = await supabase.from("requests").insert([
      {
        user_id: user.id,
        type,
        date,
        number,
        requested_by,
        urgency,
        due_date,
        status,
        tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
        items,
        grand_total,
      },
    ]);

    if (error) {
      return res.status(500).json({
        error: true,
        message: "Failed to create request: " + error.message,
      });
    }

    return res.status(201).json({
      error: false,
      message: "Request created successfully",
    });
  } catch (err) {
    console.error("[Request ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
