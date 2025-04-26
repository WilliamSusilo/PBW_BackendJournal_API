const { getSupabaseWithToken } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "PUT" && req.method !== "PATCH") {
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

    const { newName } = req.body;
    console.log("Name = ", newName);

    if (typeof newName !== "string" || newName.trim() === "" || newName.length > 100) {
      return res.status(400).json({ error: true, message: "Name must be a non-empty string with a maximum of 100 characters" });
    }

    const { error: updateError } = await supabase.from("profiles").update({ name: newName }).eq("id", user.id);

    if (updateError) {
      return res.status(500).json({ error: true, message: "Failed to update name: " + updateError.message });
    }

    return res.status(200).json({ error: false, message: "Name updated successfully" });
  } catch (err) {
    console.error("[UPDATE NAME ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
