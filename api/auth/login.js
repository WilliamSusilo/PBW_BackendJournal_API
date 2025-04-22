const { supabase, supabaseAdmin } = require("../../lib/supabaseClient");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    const { email, password } = req.body;

    const isValidEmail = (email) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(email);
    };

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

    // Step 2: Jika terdaftar, lanjut login
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      // Tambahkan detil error jika login gagal
      return res.status(401).json({
        error: true,
        message: "Invalid password or account is not confirmed yet.",
      });
    }

    // Step 3: Return success
    res.status(200).json({
      error: false,
      message: "Login successful!",
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
