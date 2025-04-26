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

    const { type, date, requested_by, urgency, due_date, status, tags, items } = req.body;

    if (!date || !items || items.length === 0) {
      return res.status(400).json({
        error: true,
        message: "Date and at least one item are required",
      });
    }

    // Fetch latest request number
    const { data: latestRequest, error: fetchError } = await supabase.from("requests").select("number").order("number", { ascending: true }).limit(1).single();

    if (fetchError && fetchError.code !== "PGRST116") {
      return res.status(500).json({ error: true, message: "Failed to fetch latest request number: " + fetchError.message });
    }

    let nextNumber = "1"; // default
    if (latestRequest && latestRequest.number !== undefined && latestRequest.number !== null) {
      const lastNumberInt = parseInt(latestRequest.number, 10);
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

    const { error } = await supabase.from("requests").insert([
      {
        user_id: user.id,
        type,
        date,
        number: nextNumber,
        requested_by,
        urgency,
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
