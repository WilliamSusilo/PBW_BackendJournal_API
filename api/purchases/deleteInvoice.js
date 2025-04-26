const { getSupabaseWithToken } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "DELETE") {
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

    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        error: true,
        message: "Invoice ID is required",
      });
    }

    // Cek apakah invoice tersebut milik user
    const { data: invoice, error: fetchError } = await supabase.from("invoices").select("id").eq("id", id);

    if (fetchError || !invoice || invoice.length === 0) {
      return res.status(404).json({
        error: true,
        message: "Invoice not found",
      });
    }

    // Hapus invoice
    const { error: deleteError } = await supabase.from("invoices").delete().eq("id", id);

    if (deleteError) {
      return res.status(500).json({
        error: true,
        message: "Failed to delete invoice: " + deleteError.message,
      });
    }

    return res.status(200).json({
      error: false,
      message: "Invoice deleted successfully",
    });
  } catch (err) {
    console.error("[DELETE INVOICE ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
