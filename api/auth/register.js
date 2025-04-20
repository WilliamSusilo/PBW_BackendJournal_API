const { createClient } = require("@supabase/supabase-js");
const supabase = require("../../lib/supabaseClient");

// Fungsi sederhana untuk validasi format email
function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: true, message: "Method not allowed" });
  }

  try {
    const { name, email, password } = req.body;

    // Validasi input
    if (!name || !email || !password) {
      return res.status(400).json({ error: true, message: "Name, email, and password are required." });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: true, message: `Email address "${email}" is invalid` });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: true, message: "Password must be at least 6 characters long." });
    }

    // Step 1: Register user di Supabase Auth
    const { data, error: signupError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name }, // Ini akan tersimpan di auth.users -> user_metadata
      },
    });

    if (signupError) throw signupError;

    const user = data?.user;
    const accessToken = data?.session?.access_token;

    if (!user) {
      throw new Error("Sign up failed: user not returned.");
    }

    // Jika session tidak ada, artinya user harus konfirmasi email
    if (!accessToken) {
      return res.status(200).json({
        error: false,
        message: "Sign up successful. Please confirm your email before continuing.",
        userId: user.id,
      });
    }

    // Step 2: Buat Supabase client baru dengan access token user
    const supabaseWithAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    });

    // Step 3: Insert ke tabel 'profiles' (id otomatis akan pakai auth.uid())
    const { error: profileError } = await supabaseWithAuth.from("profiles").insert([{ name, email }]);

    if (profileError) throw profileError;

    // Step 4: Kirim respons sukses
    res.status(200).json({
      error: false,
      message: "User successfully registered!",
      userId: user.id,
    });
  } catch (error) {
    console.error("❌ Error saat register:", JSON.stringify(error, null, 2));
    res.status(400).json({
      error: true,
      message: error.message || JSON.stringify(error),
    });
  }
};
