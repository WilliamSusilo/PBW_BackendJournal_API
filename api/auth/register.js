const { supabase, supabaseAdmin, getSupabaseWithToken } = require("../../lib/supabaseClient");

// Email validation
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
    const { name, email, password } = req.body;

    // Input validation
    if (!name || !email || !password) {
      return res.status(400).json({ error: true, message: "Name, email, and password are required." });
    }

    if (typeof name !== "string" || name.trim() === "" || name.length > 100) {
      return res.status(400).json({ error: true, message: "Name must be a non-empty string with a maximum of 100 characters" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: true, message: `Email address "${email}" is invalid` });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: true, message: "Password must be at least 8 characters long." });
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

    if (foundUser) {
      return res.status(404).json({
        error: true,
        message: "Account already has been registered",
      });
    }

    // Register in Supabase Auth
    const { data, error: signupError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name }, // It will be save in auth.users -> user_metadata
        emailRedirectTo: "https://your-frontend.com/email-confirmed", // Direct to other page after confirm emails
      },
    });

    if (signupError) throw signupError;

    const user = data?.user;
    const accessToken = data?.session?.access_token;

    if (!user) {
      throw new Error("Sign up failed: user not returned.");
    }

    // If there is no session, user must confirm the email
    if (!accessToken) {
      return res.status(200).json({
        error: false,
        message: "Sign up successful. Please confirm your email before continuing.",
        userId: user.id,
      });
    }

    const supabaseWithAuth = getSupabaseWithToken(accessToken);

    // Insert to'profiles' table (id will automatically use auth.uid())
    const { error: profileError } = await supabaseWithAuth.from("profiles").insert([{ id: user.id, name, email }]);

    if (profileError) throw profileError;
  } catch (error) {
    console.error("Error while  register:", JSON.stringify(error, null, 2));
    res.status(500).json({
      error: true,
      message: error.message || JSON.stringify(error),
    });
  }
};
