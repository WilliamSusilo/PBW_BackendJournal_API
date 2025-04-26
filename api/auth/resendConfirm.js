const { supabase } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: true, message: "Email is required" });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: "https://yourfrontend.com/confirm-email",
    });

    if (error) {
      return res.status(500).json({ error: true, message: "Failed to resend confirmation email: " + error.message });
    }

    return res.status(200).json({
      error: false,
      message: "Confirmation email sent successfully",
    });
  } catch (err) {
    console.error("[RESEND CONFIRMATION ERROR]", err);
    return res.status(500).json({ error: true, message: "Server error: " + err.message });
  }
};
