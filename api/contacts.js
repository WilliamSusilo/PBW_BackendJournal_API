const { getSupabaseWithToken } = require("../lib/supabaseClient");

module.exports = async (req, res) => {
  const { method, query } = req;
  const body = req.body;
  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
      // Add Contact Endpoint
      case "addContact": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addContact." });
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

        const { category, name, email, phone, address } = req.body;

        if (!category || !name || !email || !phone || !address) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const validCategories = ["Customer", "Vendor", "Employee"];
        if (!validCategories.includes(category)) {
          return res.status(400).json({ error: true, message: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
        }

        const { data: maxNumberData, error: fetchError } = await supabase.from("contacts").select("number").eq("user_id", user.id).eq("category", category).order("number", { ascending: false }).limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest contact number: " + fetchError.message });
        }

        let newNumber = 1;
        if (maxNumberData && maxNumberData.length > 0) {
          newNumber = maxNumberData[0].number + 1;
        }

        const { error: insertError } = await supabase.from("contacts").insert([
          {
            user_id: user.id,
            number: newNumber,
            category,
            name,
            email,
            phone,
            address,
          },
        ]);

        if (insertError) {
          return res.status(500).json({
            error: true,
            message: "Failed to create contact: " + insertError.message,
          });
        }

        return res.status(201).json({ error: false, message: "Contact created successfully", number: newNumber });
      }

      // Edit Contact Endpoint
      case "editContact": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editContact." });
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

        const { id, category, name, email, phone, address } = req.body;

        if (!id || !category || !name || !email || !phone || address === undefined) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const { error: updateError } = await supabase
          .from("contacts")
          .update({
            category,
            name,
            email,
            phone,
            address,
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update contact: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Contact updated successfully" });
      }

      // Delete Contact Endpoint
      case "deleteContact": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteContact." });
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
        } = await supabase.auth.getUser(token);

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Contact ID is required" });
        }

        const { data: expense, error: fetchError } = await supabase.from("contacts").select("id").eq("id", id);

        if (fetchError || !expense || expense.length === 0) {
          return res.status(404).json({ error: true, message: "Contact not found" });
        }

        const { error: deleteError } = await supabase.from("contacts").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete contact: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Contact deleted successfully" });
      }

      // Get All Contacts Endpoint
      case "getContacts": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getContacts." });
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

        const { category, limit } = req.query;

        const limitValue = limit ? parseInt(limit) : 10;

        let query = supabase.from("contacts").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
        if (category) query = query.eq("category", category);
        query = query.limit(limitValue);

        const { data: contacts, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch contacts: " + fetchError.message });
        }

        return res.status(200).json({ error: false, data: contacts });
      }

      // Get Contact Person Endpoint
      case "getContactPerson": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getContactPerson." });
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

        const { id } = req.query;

        let query = supabase.from("contacts").select("*").eq("user_id", user.id).order("created_at", { ascending: false });

        if (id) {
          query = query.eq("id", id);
        }

        const { data: contacts, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch contacts: " + fetchError.message });
        }

        return res.status(200).json({ error: false, data: contacts });
      }

      // Get Contact Total Expenses Endpoint
      case "getContactExpenses": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getContactExpenses." });
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

        const { data: invoices, error: fetchError } = await supabase.from("invoices").select("grand_total").eq("user_id", user.id);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + fetchError.message });
        }

        const expensesByContact = {};
        invoices.forEach((invoice) => {
          const contactId = invoice.user_id;
          const total = invoice.grand_total || 0;

          if (!expensesByContact[contactId]) {
            expensesByContact[contactId] = 0;
          }
          expensesByContact[contactId] += total;
        });

        return res.status(200).json({
          error: false,
          data: expensesByContact, // Example: { "contact1": 5000, "contact2": 3200 }
        });
      }

      // Get Contact Total Incomes Endpoint
      case "getContactIncomes": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getContactIncomes." });
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

        const { data: sales, error: fetchError } = await supabase.from("sales").select("total").eq("user_id", user.id);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sales: " + fetchError.message });
        }

        const incomesByContact = {};
        sales.forEach((sale) => {
          const contactId = sale.user_id;
          const total = sale.total || 0;

          if (!incomesByContact[contactId]) {
            incomesByContact[contactId] = 0;
          }
          incomesByContact[contactId] += total;
        });

        return res.status(200).json({
          error: false,
          data: incomesByContact, // Example: { "contact1": 5000, "contact2": 3200 }
        });
      }

      default:
        return res.status(400).json({ error: true, message: "Invalid action" });
    }
  } catch (error) {
    return res.status(500).json({ error: true, message: "Internal server error: " + error.message });
  }
};
