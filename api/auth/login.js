const supabase = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    const { email, password } = req.body;

    // Step 1: Login using Supabase Auth
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    // Step 2: Return success response with user data and JWT
    res.status(200).json({
      error: false,
      message: "Login successful!",
      user: data.user,
      session: data.session,
    });
  } catch (error) {
    res.status(400).json({
      error: true,
      message: error.message,
    });
  }
};
