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
    } = await supabase.auth.getUser(token);

    if (userError || !user) {
      return res.status(401).json({ error: true, message: "Invalid or expired token" });
    }

    const { type, date, number, approver, due_date, status, tags, items, tax_calculation_method, ppn_percentage, pph_type, pph_percentage } = req.body;

    if (!number || !date || !items || items.length === 0) {
      return res.status(400).json({
        error: true,
        message: "Invoice number, date, and at least one item are required",
      });
    }

    const dpp = items.reduce((sum, item) => {
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      return sum + qty * price;
    }, 0);

    const ppn = (dpp * (ppn_percentage || 0)) / 100;
    const pph = (dpp * (pph_percentage || 0)) / 100;
    const grand_total = dpp + ppn - pph;

    const { error } = await supabase.from("invoices").insert([
      {
        user_id: user.id,
        type,
        date,
        number,
        approver,
        due_date,
        status,
        tags,
        items,
        tax_calculation_method,
        ppn_percentage,
        pph_type,
        pph_percentage,
        dpp,
        ppn,
        pph,
        grand_total,
      },
    ]);

    if (error) {
      return res.status(500).json({
        error: true,
        message: "Failed to create invoice: " + error.message,
      });
    }

    return res.status(201).json({
      error: false,
      message: "Invoice created successfully",
    });
  } catch (err) {
    console.error("[INVOICE ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
