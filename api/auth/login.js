const { supabase, supabaseAdmin } = require("../../lib/supabaseClient");

function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

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
    const { email, password } = req.body;

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: true,
        message: "Please provide a valid email address.",
      });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        error: true,
        message: "Password must be at least 8 characters long.",
      });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({
        error: true,
        message: "Password must contain uppercase, lowercase, number, and special character.",
      });
    }

    const { data: users, error: checkError } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (checkError) throw checkError;

    const foundUser = users?.users?.find((user) => user.email === email);

    if (!foundUser) {
      return res.status(404).json({
        error: true,
        message: "Account with this email is not registered.",
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(401).json({
        error: true,
        message: "Invalid password or account is not confirmed yet.",
      });
    }

    res.status(200).json({
      error: false,
      message: "Login successful",
      user: data.user,
      session: data.session,
    });
  } catch (error) {
    res.status(500).json({
      error: true,
      message: error.message || "Unexpected server error",
    });
  }
};
