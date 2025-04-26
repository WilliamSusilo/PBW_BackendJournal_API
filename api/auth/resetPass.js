const { getSupabaseWithToken } = require("../../lib/supabaseClient");

function isStrongPassword(password) {
  const minLength = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);

  return minLength && hasUpper && hasLower && hasNumber && hasSymbol;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    const { access_token, new_password } = req.body;

    if (!access_token || !new_password) {
      return res.status(400).json({ error: true, message: "Access token and new password are required." });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ error: true, message: "Password must be at least 8 characters long." });
    }

    if (!isStrongPassword(new_password)) {
      return res.status(400).json({
        error: true,
        message: "Password must contain uppercase, lowercase, number, and special character.",
      });
    }

    const supabaseWithAuth = getSupabaseWithToken(access_token);

    const { error } = await supabaseWithAuth.auth.updateUser({
      password: new_password,
    });

    if (error) {
      throw error;
    }

    return res.status(200).json({
      error: false,
      message: "Password has been updated successfully.",
    });
  } catch (error) {
    console.error("Error while updating password:", JSON.stringify(error, null, 2));
    res.status(500).json({
      error: true,
      message: error.message || JSON.stringify(error),
    });
  }
};
