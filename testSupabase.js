// testSupabase.js
const supabase = require("./lib/supabaseClient");

(async () => {
  const { data, error } = await supabase.from("profiles").select("*").limit(1);
  console.log({ data, error });
})();
