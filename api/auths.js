const { supabase, supabaseAdmin, getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE"],
  origin: ["http://localhost:8080", "http://192.168.100.3:8080", "https://prabaraja-webapp.vercel.app"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// Helper for run middleware with async
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
}

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
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { method, query } = req;
  const body = req.body;
  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
      // Register Endpoint
      case "register": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for register." });
        }

        const { name, email, password } = body;

        if (!name || !email || !password) return res.status(400).json({ error: true, message: "Name, email, and password are required." });

        if (typeof name !== "string" || name.trim() === "" || name.length > 100) return res.status(400).json({ error: true, message: "Name must be a non-empty string with a maximum of 100 characters." });

        if (!isValidEmail(email)) return res.status(400).json({ error: true, message: `Email address "${email}" is invalid.` });

        if (!isStrongPassword(password)) return res.status(400).json({ error: true, message: "Password must contain uppercase, lowercase, number, and special character." });

        const { data: users, error: checkError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (checkError) throw checkError;

        if (users?.users?.some((user) => user.email === email)) return res.status(409).json({ error: true, message: "Account already has been registered." });

        const { data, error: signupError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              name, // insert into user_metadata
              // role,
            },
          },
        });
        if (signupError) throw signupError;

        const user = data?.user;
        const accessToken = data?.session?.access_token;

        if (!user) throw new Error("Sign up failed: user not returned.");

        if (!accessToken) {
          return res.status(200).json({
            error: false,
            message: "Sign up successful. Please confirm your email before continuing.",
            userId: user.id,
          });
        }

        const supabaseWithAuth = getSupabaseWithToken(accessToken);
        const { error: profileError } = await supabaseWithAuth.from("profiles").update([{ name }]).eq("id", user.id);
        if (profileError) throw profileError;

        return res.status(200).json({ error: false, message: "Registration successful", user });
      }

      // Login Endpoint
      case "login": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for login." });
        }

        const { email, password } = body;

        if (!email || !isValidEmail(email)) return res.status(400).json({ error: true, message: "Please provide a valid email address." });

        if (!isStrongPassword(password)) return res.status(400).json({ error: true, message: "Password must contain uppercase, lowercase, number, and special character." });

        const { data: users, error: checkError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (checkError) throw checkError;

        const foundUser = users?.users?.find((user) => user.email === email);
        if (!foundUser) return res.status(404).json({ error: true, message: "Account not registered." });

        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) return res.status(401).json({ error: true, message: "Invalid password or account is not confirmed yet." });

        return res.status(200).json({ error: false, message: "Login successful", user: data.user, session: data.session });
      }

      // Logout Endpoint
      case "logout": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for logout." });
        }

        await supabase.auth.signOut();
        return res.status(200).json({ error: false, message: "Logout successful" });
      }

      // Resend Confirmation Email Endpoint
      case "resendConfirm": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for resendConfirm." });
        }

        const { email } = body;
        if (!email || !isValidEmail(email)) return res.status(400).json({ error: true, message: "Please provide a valid email address." });

        const { error } = await supabase.auth.resend({
          type: "signup",
          email,
          options: {
            emailRedirectTo: "https://yourfrontend.com/confirm-email",
          },
        });
        if (error) {
          return res.status(500).json({ error: true, message: "Failed to resend confirmation email: " + error.message });
        }

        return res.status(200).json({ error: false, message: "Confirmation email sent" });
      }

      //   Reset Password Endpoint
      case "resetPass": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for resetPass." });
        }

        const { access_token, refresh_token, new_password } = body;
        if (!access_token || !refresh_token || !new_password) return res.status(400).json({ error: true, message: "Access token, refresh token, and new password are required" });

        if (!isStrongPassword(new_password)) return res.status(400).json({ error: true, message: "Password must contain uppercase, lowercase, number, and special character." });

        const { error: sessionError } = await supabase.auth.setSession({
          access_token,
          refresh_token,
        });

        if (sessionError) {
          return res.status(401).json({
            error: true,
            message: "Failed to establish session: " + sessionError.message,
          });
        }

        const { error: updateError } = await supabase.auth.updateUser({ password: new_password });
        if (updateError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update password: " + updateError.message,
          });
        }

        return res.status(200).json({ error: false, message: "Password updated successfully" });
      }

      //   Reset Password by Admin Endpoint
      case "resetPassAdmin": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for resetPassAdmin." });
        }

        const { access_token, refresh_token, user_id, new_password } = body;
        if (!access_token || !refresh_token || !user_id || !new_password) return res.status(400).json({ error: true, message: "Access token, refresh token, id, and new password are required" });

        if (!isStrongPassword(new_password)) return res.status(400).json({ error: true, message: "Password must contain uppercase, lowercase, number, and special character." });

        if (!user_id || !new_password) {
          return res.status(400).json({ error: true, message: "User ID and new password are required" });
        }

        // Get admin user from current session
        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "Authorization header required" });
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

        // Get user roles from database (e.g. 'profiles' or 'users' table)
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        // Check if the user role is among those permitted
        const allowedRoles = ["admin"];
        if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user_id, { password: new_password });
        if (updateError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update password: " + updateError.message,
          });
        }

        return res.status(200).json({ error: false, message: "Password updated successfully" });
      }

      //   Forgot Password Endpoint
      case "forgotPass": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for forgotPass." });
        }

        const { email } = body;
        if (!email || !isValidEmail(email)) return res.status(400).json({ error: true, message: "Please provide a valid email address." });

        const { data: user, error: userError } = await supabase.from("users").select("*").eq("email", email).single();

        if (userError || !user) {
          return res.status(404).json({ error: true, message: "Email not found in our records." });
        }

        const { error } = await supabase.auth.resetPasswordForEmail(email);
        if (error) throw error;

        return res.status(200).json({ error: false, message: "Reset password email sent. Please check your inbox." });
      }

      // Update Name Endpoint
      case "updateName": {
        if (req.method !== "PUT" && req.method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT or PATCH for updateName" });
        }

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
      }

      // Update Role Endpoint
      case "updateRole": {
        if (req.method !== "PUT" && req.method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT or PATCH for updateRole" });
        }

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

        // Get user roles from database (e.g. 'profiles' or 'users' table)
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        // Check if the user role is among those permitted
        const allowedRoles = ["admin"];
        if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id, newRole } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required field: ID" });
        }

        if (typeof newRole !== "string" || newRole.trim() === "" || newRole.length > 100) {
          return res.status(400).json({ error: true, message: "Role must be a non-empty string with a maximum of 100 characters" });
        }

        const { error: updateError } = await supabase.from("profiles").update({ role: newRole }).eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update role: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Role updated successfully" });
      }

      // Get User and Role Endpoint
      case "getRole": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getRole." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

        // Get user roles from database (e.g. 'profiles' or 'users' table)
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        // Check if the user role is among those permitted
        const allowedRoles = ["admin"];
        if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        let query = supabase.from("profiles").select("id, email, name, role");

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch user and role: " + error.message });

        return res.status(200).json({ error: false, data });
      }

      // Non-existent Endpoint
      default:
        return res.status(404).json({ error: true, message: "Endpoint not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: true, message: error.message || "Unexpected server error" });
  }
};
