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

    const { type, date, approver, due_date, status, tags, items, tax_calculation_method, ppn_percentage, pph_type, pph_percentage } = req.body;

    if (!date || !items || items.length === 0) {
      return res.status(400).json({
        error: true,
        message: "Date and at least one item are required",
      });
    }

    // Fetch latest invoice number
    const { data: latestInvoice, error: fetchError } = await supabase.from("invoices").select("number").order("number", { ascending: true }).limit(1).single();

    if (fetchError && fetchError.code !== "PGRST116") {
      return res.status(500).json({ error: true, message: "Failed to fetch latest invoice number: " + fetchError.message });
    }

    let nextNumber = "1"; // default
    if (latestInvoice && latestInvoice.number !== undefined && latestInvoice.number !== null) {
      const lastNumberInt = parseInt(latestInvoice.number, 10);
      nextNumber = lastNumberInt + 1;
    }

    // Update items with total_per_item
    const updatedItems = items.map((item) => {
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      const total_per_item = qty * price;

      return {
        ...item,
        total_per_item,
      };
    });

    const dpp = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

    // Calculate PPN and PPh
    const ppn = (dpp * (ppn_percentage || 0)) / 100;
    const pph = (dpp * (pph_percentage || 0)) / 100;

    // Final grand total
    const grand_total = dpp + ppn - pph;

    const { error } = await supabase.from("invoices").insert([
      {
        user_id: user.id,
        type,
        date,
        number: nextNumber,
        approver,
        due_date,
        status,
        tags,
        items: updatedItems,
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
