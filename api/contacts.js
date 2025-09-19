const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE"],
  origin: ["http://localhost:8080", "http://192.168.100.3:8080", "https://prabaraja-webapp.vercel.app", "https://prabaraja-project.vercel.app"],
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

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { category, name, email, phone, address } = req.body;

        if (!category || !name || !email || !phone || !address) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const validCategories = ["Customer", "Vendor", "Employee"];
        if (!validCategories.includes(category)) {
          return res.status(400).json({ error: true, message: `Invalid category. Must be one of: ${validCategories.join(", ")}` });
        }

        const { data: maxNumberData, error: fetchError } = await supabase.from("contacts").select("number").eq("category", category).order("number", { ascending: false }).limit(1);

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

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, category, name, email, phone, address } = req.body;

        if (!id) {
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

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

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

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { category } = req.query;
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("contacts").select("*").order("created_at", { ascending: false }).range(from, to);

        if (category) query = query.eq("category", category);

        if (search) {
          const stringColumns = ["category", "name", "email", "phone", "address"];
          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          const eqIntConditions = [];

          // Check if the search can be convert into number
          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push(`number.eq.${search}`);
          }

          // Check the code, for example CUST001 → get the number
          const codeMatch = search.match(/^(CUST|EMPL|VEND)(\d{3,})$/i);
          if (codeMatch) {
            const codeNum = parseInt(codeMatch[2], 10); // get the number from code like CUST001
            if (!isNaN(codeNum)) {
              eqIntConditions.push(`number.eq.${codeNum}`);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch contacts: " + fetchError.message });
        }

        const prefixMap = {
          Customer: "CUST",
          Employee: "EMPL",
          Vendor: "VEND",
        };

        const formattedData = data.map((item) => {
          const prefix = prefixMap[item.category] || "UNK";
          return {
            ...item,
            number: `${prefix}${String(item.number).padStart(3, "0")}`,
          };
        });

        return res.status(200).json({ error: false, data: formattedData });
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

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.query;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Contact ID" });
        }

        let query = supabase.from("contacts").select("*").eq("id", id).order("created_at", { ascending: false });

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

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        // const { data: invoices, error: fetchError } = await supabase.from("invoices").select("grand_total");

        // if (fetchError) {
        //   return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + fetchError.message });
        // }

        // const expensesByContact = {};
        // invoices.forEach((invoice) => {
        //   const contactId = invoice.user_id;
        //   const total = invoice.grand_total || 0;

        //   if (!expensesByContact[contactId]) {
        //     expensesByContact[contactId] = 0;
        //   }
        //   expensesByContact[contactId] += total;
        // });

        // return res.status(200).json({
        //   error: false,
        //   data: expensesByContact, // Example: { "contact1": 5000, "contact2": 3200 }
        // });

        // Get all invoice data from user
        const { data: invoices, error: fetchError } = await supabase.from("invoices").select("*");

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + fetchError.message });
        }

        // Calculate the expense total from all invoice
        const totalExpenses = invoices.reduce((acc, invoice) => acc + (invoice.grand_total || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            invoices,
            total_expenses: totalExpenses,
          },
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

        // // Get user roles from database (e.g. 'profiles' or 'users' table)
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Check if the user role is among those permitted
        // const allowedRoles = ["manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        // const { data: sales, error: fetchError } = await supabase.from("sales").select("grand_total");

        // if (fetchError) {
        //   return res.status(500).json({ error: true, message: "Failed to fetch sales: " + fetchError.message });
        // }

        // const incomesByContact = {};
        // sales.forEach((sale) => {
        //   const contactId = sale.user_id;
        //   const total = sale.total || 0;

        //   if (!incomesByContact[contactId]) {
        //     incomesByContact[contactId] = 0;
        //   }
        //   incomesByContact[contactId] += total;
        // });

        // return res.status(200).json({
        //   error: false,
        //   data: incomesByContact, // Example: { "contact1": 5000, "contact2": 3200 }
        // });
        // Get all sale data from user
        const { data: sales, error: fetchError } = await supabase.from("sales").select("*");

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sales: " + fetchError.message });
        }

        // Calculate the income total from all sale
        const totalIncomes = sales.reduce((acc, sale) => acc + (sale.grand_total || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            sales,
            total_incomes: totalIncomes,
          },
        });
      }

      default:
        return res.status(400).json({ error: true, message: "Invalid action" });
    }
  } catch (error) {
    return res.status(500).json({ error: true, message: "Internal server error: " + error.message });
  }
};
