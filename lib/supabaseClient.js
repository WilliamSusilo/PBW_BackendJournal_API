// lib/supabaseClient.js

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Default supabase client (tanpa token)
const supabase = createClient(supabaseUrl, supabaseKey);

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Penting! Gunakan service_role
);

// Fungsi untuk membuat supabase client dengan token tertentu (misal accessToken user)
const getSupabaseWithToken = (accessToken) => {
  return createClient(supabaseUrl, supabaseKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
};

module.exports = {
  supabase,
  supabaseAdmin,
  getSupabaseWithToken,
};
