const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS"],
  origin: ["http://localhost:8080/", "https://prabaraja-webapp.vercel.app/"],
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

module.exports = async (req, res) => {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { method, query } = req;
  let body = {};
  if (req.method !== "GET") {
    try {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const rawBody = Buffer.concat(buffers).toString();
      body = JSON.parse(rawBody);
    } catch (err) {
      console.error("Error parsing JSON:", err.message);
      return res.status(400).json({ error: true, message: "Invalid JSON body" });
    }
  }

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

        const { account_name, account_type, bank_name, bank_number, balance, type } = req.body;

        if (!account_name || !account_type || !bank_name || !bank_number || !balance || !type) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const { data: maxNumberData, error: fetchError } = await supabase.from("cashbank").select("number").order("number", { ascending: false }).limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest account number: " + fetchError.message });
        }

        let newNumber = 1;
        if (maxNumberData && maxNumberData.length > 0) {
          newNumber = maxNumberData[0].number + 1;
        }

        const { error: insertError } = await supabase.from("cashbank").insert([
          {
            user_id: user.id,
            account_name,
            number: newNumber,
            account_type,
            bank_name,
            bank_number,
            balance: Number(balance),
            status: "Active",
            type,
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

        const { id, account_name, account_type, bank_name, bank_number, balance, type } = req.body;

        if (!id || !account_name || !account_type || !bank_name || !bank_number || !balance || !type) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const { error: updateError } = await supabase
          .from("cashbank")
          .update({
            account_name,
            account_type,
            bank_name,
            bank_number,
            balance: Number(balance),
            type,
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update account: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Account updated successfully" });
      }

      // Archive and Unarchive Account Endpoint
      case "archiveAccount":
      case "unarchiveAccount": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use PATCH for ${action}.` });
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
          return res.status(400).json({ error: true, message: "Missing required field: ID" });
        }

        const entityname = action === "archiveAccount" ? "Archive" : "Active";

        // Update status to 'Archive' or 'Unarchive'
        const { error: updateError } = await supabase.from("cashbank").update({ status: entityname }).eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: `Failed to ${entityname} account: ` + updateError.message });
        }

        return res.status(200).json({ error: false, message: `Account ${entityname} successfully` });
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
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("cashbank").select("*").order("created_at", { ascending: false }).eq("status", status).range(from, to);

        if (search) {
          const stringColumns = ["account_name", "account_type", "bank_name", "bank_number", "type"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("balance.eq." + parseFloat(search));
          }

          const codeMatch = search.match(/^BANK-?0*(\d{5,})$/i);
          if (codeMatch) {
            const extractedNumber = parseInt(codeMatch[1], 10);
            if (!isNaN(extractedNumber)) {
              eqIntConditions.push("number.eq." + extractedNumber);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data: accounts, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch accounts: " + fetchError.message });
        }

        const formattedData = accounts.map((item) => ({
          ...item,
          number: `${"BANK-"}${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Debit Balance Endpoint
      case "getDebitBalance": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getDebitBalance." });
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

        const { data: debitAccounts, error: debitError } = await supabase.from("cashbank").select("balance").eq("account_type", "Debit").eq("status", "Active");

        if (debitError) {
          return res.status(500).json({ error: true, message: "Failed to fetch debit balance: " + debitError.message });
        }

        const totalDebitBalance = debitAccounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0);

        return res.status(200).json({ error: false, total_debit_balance: totalDebitBalance });
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

        const { data: creditAccounts, error: creditError } = await supabase.from("cashbank").select("balance").eq("account_type", "Credit").eq("status", "Active");

        if (creditError) {
          return res.status(500).json({ error: true, message: "Failed to fetch credit balance: " + creditError.message });
        }

        const totalCreditBalance = creditAccounts.reduce((sum, acc) => sum + parseFloat(acc.balance || 0), 0);

        return res.status(200).json({ error: false, total_credit_balance: totalCreditBalance });
      }

      case "transferFunds": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST." });
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

        const { from_account_id, to_account_id, amount, notes } = req.body;

        if (!from_account_id || !to_account_id || !amount) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        if (from_account_id === to_account_id) {
          return res.status(400).json({ error: true, message: "From and To accounts must be different" });
        }

        const amountValue = parseFloat(amount);
        if (isNaN(amountValue) || amountValue <= 0) {
          return res.status(400).json({ error: true, message: "Invalid transfer amount" });
        }

        const { data: fromAccount, error: fromError } = await supabase.from("cashbank").select("balance").eq("id", from_account_id).single();
        const { data: toAccount, error: toError } = await supabase.from("cashbank").select("balance").eq("id", to_account_id).single();

        if (fromError || toError || !fromAccount || !toAccount) {
          return res.status(404).json({ error: true, message: "Source or destination account not found" });
        }

        if (Number(amount) > Number(fromAccount.balance)) {
          return res.status(400).json({ error: true, message: "Insufficient balance in from account" });
        }

        // Balance before
        const fromBefore = Number(fromAccount.balance);
        const toBefore = Number(toAccount.balance);

        // Balance after
        const fromAfter = fromBefore - Number(amount);
        const toAfter = toBefore + Number(amount);

        // Update balance
        const { error: deductError } = await supabase.from("cashbank").update({ balance: fromAfter }).eq("id", from_account_id);
        const { error: addError } = await supabase.from("cashbank").update({ balance: toAfter }).eq("id", to_account_id);

        if (deductError || addError) {
          return res.status(500).json({ error: true, message: "Failed to transfer funds" });
        }

        // Record the transaction
        const { data: maxNumberData, error: fetchError } = await supabase.from("bank_transfer_transactions").select("number").order("number", { ascending: false }).limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest transfer transaction: " + fetchError.message });
        }

        let newNumber = 1;
        if (maxNumberData && maxNumberData.length > 0) {
          newNumber = maxNumberData[0].number + 1;
        }

        // Save the transactions data
        const { error: insertError } = await supabase.from("bank_transfer_transactions").insert([
          {
            user_id: user.id,
            number: newNumber,
            from_account: from_account_id,
            to_account: to_account_id,
            amount: Number(amount),
            notes,
            source_balance_before: fromBefore,
            source_balance_after: toBefore,
            target_balance_before: fromAfter,
            target_balance_after: toAfter,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to create transfer: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Transfer recorded successfully" });
      }

      case "receiveMoney": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST." });
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

        const {
          receiving_account_id,
          amount,
          payer_name,
          reference,
          date_received,
          notes,
          // proof_file, // Assume this is a base64 encoded file or a file object
        } = req.body;

        // let proof_url = null;

        // if (proof_file) {
        //   const fileName = `proofs/${user.id}_${Date.now()}.png`; // Adjust extension as needed
        //   const { data: uploadData, error: uploadError } = await supabase.storage.from("receipts").upload(fileName, proof_file, {
        //     contentType: "image/png", // Adjust content type as needed
        //     upsert: false,
        //   });

        //   if (uploadError) {
        //     return res.status(500).json({ error: true, message: "Failed to upload proof: " + uploadError.message });
        //   }

        //   proof_url = uploadData.path;
        // }

        if (!receiving_account_id || !amount || !payer_name || !date_received) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const amountValue = parseFloat(amount);
        if (isNaN(amountValue) || amountValue <= 0) {
          return res.status(400).json({ error: true, message: "Invalid received amount" });
        }

        const { data: toAccount, error: toError } = await supabase.from("cashbank").select("balance").eq("id", receiving_account_id).single();

        if (toError || !toAccount) {
          return res.status(404).json({ error: true, message: "Source or destination account not found" });
        }

        // Balance before
        const toBefore = Number(toAccount.balance);

        // Balance after
        const toAfter = toBefore + Number(amount);

        // Update balance
        const { error: updateError } = await supabase.from("cashbank").update({ balance: toAfter }).eq("id", receiving_account_id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update balance: " + updateError.message });
        }

        // Record the transaction
        const { data: maxNumberData, error: fetchError } = await supabase.from("bank_receive_transactions").select("number").order("number", { ascending: false }).limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest receive transaction: " + fetchError.message });
        }

        let newNumber = 1;
        if (maxNumberData && maxNumberData.length > 0) {
          newNumber = maxNumberData[0].number + 1;
        }

        const { error: insertError } = await supabase.from("bank_receive_transactions").insert([
          {
            user_id: user.id,
            number: newNumber,
            receiving_account: receiving_account_id,
            amount: Number(amount),
            payer_name,
            reference,
            date_received,
            notes,
            // proof_url,
            target_balance_before: toBefore,
            target_balance_after: toAfter,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to record received money: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Received money recorded successfully" });
      }

      // Get All Transfer Money Endpoint
      case "getTransfers": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET." });
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

        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("bank_transfer_transactions").select("*").order("created_at", { ascending: false }).range(from, to);

        if (search) {
          const stringColumns = ["notes"];
          const uuidColumns = ["from_account", "to_account"];
          const numericColumns = ["amount", "source_balance_before", "source_balance_after", "target_balance_before", "target_balance_after"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          // Validation if search is UUID
          const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(search);

          // Make condition for eq if UUID match
          const eqUUIDConditions = isValidUUID ? uuidColumns.map((col) => `${col}.eq.${search}`) : [];

          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            const value = parseFloat(search);
            eqFloatConditions.push(...numericColumns.map((col) => `${col}.eq.${value}`));
          }

          const codeMatch = search.match(/^TRF-?0*(\d{5,})$/i);
          if (codeMatch) {
            const extractedNumber = parseInt(codeMatch[1], 10);
            if (!isNaN(extractedNumber)) {
              eqIntConditions.push("number.eq." + extractedNumber);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqUUIDConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data: transfers, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch transfers: " + fetchError.message });
        }

        const formattedData = transfers.map((item) => ({
          ...item,
          number: `${"TRF-"}${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get All Receive Money Endpoint
      case "getReceives": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET." });
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

        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("bank_receive_transactions").select("*").order("created_at", { ascending: false }).range(from, to);

        if (search) {
          const stringColumns = ["payer_name", "reference", "notes"];
          const uuidColumns = ["receiving_account"];
          const numericColumns = ["amount", "target_balance_before", "target_balance_after"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          // Validation if search is UUID
          const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(search);

          // Make condition for eq if UUID match
          const eqUUIDConditions = isValidUUID ? uuidColumns.map((col) => `${col}.eq.${search}`) : [];

          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            const value = parseFloat(search);
            eqFloatConditions.push(...numericColumns.map((col) => `${col}.eq.${value}`));
          }

          const codeMatch = search.match(/^REC-?0*(\d{5,})$/i);
          if (codeMatch) {
            const extractedNumber = parseInt(codeMatch[1], 10);
            if (!isNaN(extractedNumber)) {
              eqIntConditions.push("number.eq." + extractedNumber);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqUUIDConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data: receives, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch receives: " + fetchError.message });
        }

        const formattedData = receives.map((item) => ({
          ...item,
          number: `${"REC-"}${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      default:
        return res.status(400).json({ error: true, message: "Invalid action" });
    }
  } catch (error) {
    return res.status(500).json({ error: true, message: "Internal server error: " + error.message });
  }
};
