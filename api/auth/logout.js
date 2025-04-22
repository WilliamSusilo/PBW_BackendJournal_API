const { supabase } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    // Step 1: Logout the user
    await supabase.auth.signOut();

    // Step 2: Return success response
    res.status(200).json({
      error: false,
      message: "Logout successful!",
    });
  } catch (error) {
    res.status(400).json({
      error: true,
      message: error.message,
    });
  }
};
