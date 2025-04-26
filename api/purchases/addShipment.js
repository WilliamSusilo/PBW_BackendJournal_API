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

    const { type, date, tracking_number, carrier, shipping_date, due_date, status, tags, items } = req.body;

    if (!date || !items || items.length === 0) {
      return res.status(400).json({
        error: true,
        message: "Date and at least one item are required",
      });
    }

    // Fetch latest shipment number
    const { data: latestShipment, error: fetchError } = await supabase.from("shipments").select("number").order("number", { ascending: true }).limit(1).single();

    if (fetchError && fetchError.code !== "PGRST116") {
      return res.status(500).json({ error: true, message: "Failed to fetch latest shipment number: " + fetchError.message });
    }

    let nextNumber = "1"; // default
    if (latestShipment && latestShipment.number !== undefined && latestShipment.number !== null) {
      const lastNumberInt = parseInt(latestShipment.number, 10);
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

    const { error } = await supabase.from("shipments").insert([
      {
        user_id: user.id,
        type,
        date,
        number: nextNumber,
        tracking_number,
        carrier,
        shipping_date,
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
        message: "Failed to create shipment: " + error.message,
      });
    }

    return res.status(201).json({
      error: false,
      message: "Shipment created successfully",
    });
  } catch (err) {
    console.error("[SHIPMENT ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
