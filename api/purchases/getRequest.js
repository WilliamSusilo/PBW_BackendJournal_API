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

    const { status } = req.query;

    let query = supabase.from("requests").select("*").eq("user_id", user.id);

    if (status) query = query.eq("status", status);

    query = query.order("date", { ascending: true });

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: true, message: "Failed to fetch requests: " + error.message });

    const formattedData = data.map((request) => ({
      ...request,
      number: `REQ-${String(request.number).padStart(5, "0")}`,
    }));

    return res.status(200).json({ error: false, data: formattedData });
  } catch (err) {
    console.err("[Get REQUEST ERROR]");
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
