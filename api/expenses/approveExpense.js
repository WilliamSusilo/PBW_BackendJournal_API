const { getSupabaseWithToken } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "PATCH") {
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

    const { id } = req.body;
    if (!id) return res.status(400).json({ error: true, message: "Expense ID is required" });

    const { data, error } = await supabase.from("expenses").update({ status: "Paid" }).eq("id", id).select();

    console.log("ID to update:", id);

    if (error) return res.status(500).json({ error: true, message: "Failed to approve expense: " + error.message });

    if (!data || data.length === 0) {
      return res.status(404).json({ error: true, message: "Expense not found with the given ID" });
    }

    return res.status(200).json({ error: false, message: "Expense approved successfully" });
  } catch (err) {
    console.error("[Approve EXPENSE ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
