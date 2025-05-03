const { getSupabaseWithToken } = require("../lib/supabaseClient");

module.exports = async (req, res) => {
  const { method, query } = req;
  const body = req.body;
  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
      // Add Account Endpoint
      case "addAccount": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addAccount." });
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

        const { account_name, account_code, bank_name, bank_number, balance } = req.body;

        if (!account_name || !account_code || !bank_name || !bank_number || !balance) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const prefix = 10000;

        const { data: latestAccount, error: fetchError } = await supabase.from("cashbank").select("number").gte("number", prefix).order("number", { ascending: false }).limit(1);

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest account number: " + fetchError.message });
        }

        let counter = 1;
        if (latestAccount && latestAccount.length > 0) {
          const lastNumber = latestAccount[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
          counter = lastCounter + 1;
        }

        const newNumber = prefix + counter;

        const { error: insertError } = await supabase.from("cashbank").insert([
          {
            user_id: user.id,
            number: newNumber,
            account_name,
            account_code,
            bank_name,
            bank_number,
            balance: Number(balance),
            status: "Active",
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to add account: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Account added successfully" });
      }

      // Edit Account Endpoint
      case "editAccount": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editAccount." });
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

        const { id, account_name, bank_name, account_number, balance } = req.body;

        if (!id || !account_name || !bank_name || !account_number || balance === undefined) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const { error: updateError } = await supabase
          .from("cashbank")
          .update({
            account_name,
            bank_name,
            bank_number: account_number,
            balance: Number(balance),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update account: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Account updated successfully" });
      }

      // Archive Account Endpoint
      case "archiveAccount": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for archiveAccount." });
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

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required field: id" });
        }

        // Update status to 'Archive'
        const { error: updateError } = await supabase.from("cashbank").update({ status: "Archive" }).eq("id", id).eq("user_id", user.id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to archive account: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Account archived successfully" });
      }

      // Unarchive Account Endpoint
      case "unarchiveAccount": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for unarchiveAccount." });
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

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required field: id" });
        }

        // Update status to 'Archive'
        const { error: updateError } = await supabase.from("cashbank").update({ status: "Active" }).eq("id", id).eq("user_id", user.id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to unarchive account: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Account unarchived successfully" });
      }

      // Delete Account Endpoint (only if status is Archive)
      case "deleteAccount": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteAccount." });
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

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing account ID" });
        }

        // Check if the account exists and is archived
        const { data: account, error: fetchError } = await supabase.from("cashbank").select("id, status").eq("id", id).single();

        if (fetchError) {
          return res.status(404).json({ error: true, message: "Account not found or you don't have permission" });
        }

        if (account.status !== "Archive") {
          return res.status(400).json({ error: true, message: "Only archived accounts can be deleted" });
        }

        const { error: deleteError } = await supabase.from("cashbank").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete account: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Account deleted successfully" });
      }

      // Get Bank Accounts Endpoint
      case "getAccounts": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getAccounts." });
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

        const { status } = req.query;

        let query = supabase.from("cashbank").select("*").eq("user_id", user.id).order("created_at", { ascending: false });

        if (status) {
          query = query.eq("status", status);
        }

        const { data: accounts, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch accounts: " + fetchError.message });
        }

        return res.status(200).json({ error: false, data: accounts });
      }

      // Get Cash Balance Endpoint
      case "getCashBalance": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getCashBalance." });
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

        const { data: cashAccounts, error: cashError } = await supabase.from("cashbank").select("balance").eq("user_id", user.id).eq("account_type", "Cash").eq("status", "Active");

        if (cashError) {
          return res.status(500).json({ error: true, message: "Failed to fetch cash balance: " + cashError.message });
        }

        const totalCashBalance = cashAccounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0);

        return res.status(200).json({ error: false, total_cash_balance: totalCashBalance });
      }

      // Get Credit Balance Endpoint
      case "getCreditBalance": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getCreditBalance." });
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

        const { data: creditAccounts, error: creditError } = await supabase.from("cashbank").select("balance").eq("user_id", user.id).eq("account_type", "Credit").eq("status", "Active");

        if (creditError) {
          return res.status(500).json({ error: true, message: "Failed to fetch credit balance: " + creditError.message });
        }

        const totalCreditBalance = creditAccounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0);

        return res.status(200).json({ error: false, total_credit_balance: totalCreditBalance });
      }

      default:
        return res.status(400).json({ error: true, message: "Invalid action" });
    }
  } catch (error) {
    return res.status(500).json({ error: true, message: "Internal server error: " + error.message });
  }
};
