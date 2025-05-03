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

        const prefix = 100;

        const { data: latestContact, error: fetchError } = await supabase.from("contacts").select("number").gte("number", prefix).order("number", { ascending: false }).limit(1);

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest contact number: " + fetchError.message });
        }

        let counter = 1;
        if (latestContact && latestContact.length > 0) {
          const lastNumber = latestContact[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
          counter = lastCounter + 1;
        }

        const newNumber = prefix + counter;

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

        return res.status(201).json({ error: false, message: "Contact created successfully" });
      }

      //   Get Customer Endpoint
      case "getCustomer": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getCustomer." });
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

        const { data, error } = await supabase.from("contacts").select("*").eq("user_id", user.id).eq("category", "Customer");

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch customers: " + error.message });

        return res.status(200).json({ error: false, data });
      }

      //   Get Vendor Endpoint
      case "getVendor": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getVendor." });
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

        const { data, error } = await supabase.from("contacts").select("*").eq("user_id", user.id).eq("category", "Vendor");

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch vendors: " + error.message });

        return res.status(200).json({ error: false, data });
      }

      //   Get Employee Endpoint
      case "getEmployee": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getEmployee." });
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

        const { data, error } = await supabase.from("contacts").select("*").eq("user_id", user.id).eq("category", "Employee");

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch employees: " + error.message });

        return res.status(200).json({ error: false, data });
      }

      //   Get Contact Endpoint
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

        // Fetch all invoices for the user
        const { data: invoices, error: fetchError } = await supabase.from("invoices").select("grand_total").eq("user_id", user.id);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + fetchError.message });
        }

        // Group by contact_id and sum grand_total
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

      default:
        return res.status(400).json({ error: true, message: "Invalid action" });
    }
  } catch (error) {
    return res.status(500).json({ error: true, message: "Internal server error: " + error.message });
  }
};
