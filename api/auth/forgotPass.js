const { supabase } = require("../../lib/supabaseClient");

function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    const { email } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Please provide a valid email address.",
      });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: "https://your-frontend.com/reset-password",
    });

    if (error) {
      throw error;
    }

    res.status(200).json({
      error: false,
      message: "Reset password email sent. Please check your inbox.",
    });
  } catch (error) {
    res.status(500).json({
      error: true,
      message: error.message || "Unexpected error occurred.",
    });
  }
};
