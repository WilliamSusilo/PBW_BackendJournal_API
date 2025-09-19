const jsreport = require("jsreport")({
  tempDirectory: require("os").tmpdir(),
  useSandbox: false,
  extensions: {
    express: { enabled: false },
    authentication: { enabled: false },
    authorization: { enabled: false },
  },
});

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
  // let body = {};
  // if (req.method !== "GET") {
  //   try {
  //     const buffers = [];
  //     for await (const chunk of req) {
  //       buffers.push(chunk);
  //     }
  //     const rawBody = Buffer.concat(buffers).toString();
  //     console.log("Raw Body:", rawBody);

  //     body = JSON.parse(rawBody);
  //   } catch (err) {
  //     console.error("Error parsing JSON:", err.message);
  //     return res.status(400).json({ error: true, message: "Invalid JSON body" });
  //   }
  // }

  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
      // Add Expense Endpoint
      case "addExpense": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addExpense." });
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
        // const allowedRoles = ["finance", "accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { date, category, beneficiary, status, items, grand_total } = req.body;

        if (!date || !category || !beneficiary || !status || !items || items.length === 0 || !grand_total) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const requestDate = new Date(date);
        const requestMonth = requestDate.getMonth() + 1; // 0-based
        const requestYear = requestDate.getFullYear();

        // Format prefix
        const prefix = `${requestYear}${String(requestMonth).padStart(2, "0")}`;

        // Get the expenses from the same month & year
        const { data: existingExpenses, error: fetchError } = await supabase
          .from("expenses")
          .select("number")
          .gte("date", `${requestYear}-${String(requestMonth).padStart(2, "0")}-01`)
          .lt("date", `${requestYear}-${String(requestMonth + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest expense number: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (existingExpenses && existingExpenses.length > 0) {
          const lastNumber = existingExpenses[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10); // ambil setelah prefix 202504
          counter = lastCounter + 1;
        }

        // Combine prefix + counter
        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.unit_price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error: insertError } = await supabase.from("expenses").insert([
          {
            user_id: user.id,
            number: nextNumber,
            date,
            category,
            beneficiary,
            status,
            items: updatedItems,
            grand_total,
          },
        ]);

        if (insertError) return res.status(500).json({ error: true, message: "Failed to create expense: " + insertError.message });

        return res.status(201).json({ error: false, message: "Expense created successfuly" });
      }

      // Edit Expense Endpoint
      case "editExpense": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editExpense." });
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
        // const allowedRoles = ["finance", "accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, date, category, beneficiary, status, items, grand_total } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.unit_price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        const { error: updateError } = await supabase
          .from("expenses")
          .update({
            date,
            category,
            beneficiary,
            status,
            items: updatedItems,
            grand_total,
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update expense: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Expense updated successfully" });
      }

      // Approve Expense Endpoint
      case "approveExpense": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for approveExpense." });
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
        // const allowedRoles = ["finance", "accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.body;
        if (!id) return res.status(400).json({ error: true, message: "Expense ID is required" });

        const { data, error } = await supabase.from("expenses").update({ status: "Paid" }).eq("id", id).select();

        if (error) return res.status(500).json({ error: true, message: "Failed to approve expense: " + error.message });

        if (!data || data.length === 0) {
          return res.status(404).json({ error: true, message: "Expense not found with the given ID" });
        }

        return res.status(200).json({ error: false, message: "Expense approved successfully" });
      }

      // Delete Expense Endpoint
      case "deleteExpense": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteExpense." });
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
        // const allowedRoles = ["finance", "accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Expense ID is required" });
        }

        const { data: expense, error: fetchError } = await supabase.from("expenses").select("id").eq("id", id);

        if (fetchError || !expense || expense.length === 0) {
          return res.status(404).json({ error: true, message: "Expense not found" });
        }

        const { error: deleteError } = await supabase.from("expenses").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete expense: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Expense deleted successfully" });
      }

      // Get Expense Endpoint
      case "getExpense": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getExpense." });
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
        // const allowedRoles = ["finance", "accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { status } = req.query;
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("expenses").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["category", "beneficiary"];
          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("grand_total.eq." + parseFloat(search));
          }

          // For detect search like "Expense #00588"
          const codeMatch = search.match(/^expense\s?#?0*(\d{7,})$/i);
          if (codeMatch) {
            const extractedNumber = parseInt(codeMatch[1], 10);
            if (!isNaN(extractedNumber)) {
              eqIntConditions.push("number.eq." + extractedNumber);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch expenses: " + error.message });

        const formattedData = data.map((expense) => ({
          ...expense,
          number: `Expense #${String(expense.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      //   Summary Expense Endpoint
      case "summaryExpense": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for summaryExpense." });
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
        // const allowedRoles = ["finance", "accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const today = new Date();
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);

        // Fetch all expenses for the user
        const { data: expenses, error: fetchError } = await supabase.from("expenses").select("date, grand_total");

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch expenses: " + fetchError.message });
        }

        // Process grand_total
        const monthlyTotal = expenses
          .filter((expense) => {
            const expenseDate = new Date(expense.date);
            return expenseDate >= startOfMonth && expenseDate <= endOfMonth;
          })
          .reduce((sum, expense) => sum + (expense.grand_total || 0), 0);

        const last30DaysTotal = expenses
          .filter((expense) => {
            const expenseDate = new Date(expense.date);
            return expenseDate >= thirtyDaysAgo && expenseDate <= today;
          })
          .reduce((sum, expense) => sum + (expense.grand_total || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            monthly_total: monthlyTotal,
            last_30_days_total: last30DaysTotal,
          },
        });
      }

      //   Get Expense Report Endpoint
      // case "getExpenseReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getExpenseReport." });
      //   }

      //   const authHeader = req.headers.authorization;
      //   if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

      //   const token = authHeader.split(" ")[1];
      //   const supabase = getSupabaseWithToken(token);

      //   const {
      //     data: { user },
      //     error: userError,
      //   } = await supabase.auth.getUser(token);

      //   if (userError || !user) {
      //     return res.status(401).json({ error: true, message: "Invalid or expired token" });
      //   }

      //   const expenseId = req.query.id;
      //   if (!expenseId) return res.status(400).json({ error: true, message: "Missing expense id" });

      //   const { data: expense, error: fetchError } = await supabase.from("expenses").select("*").eq("id", expenseId).single();

      //   if (fetchError || !expense) {
      //     return res.status(404).json({ error: true, message: "Expense not found" });
      //   }

      //   // Format expense number
      //   const formattedExpenseNumber = String(expense.number).padStart(5, "0");

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     return `Rp. ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     return date.toISOString().split("T")[0];
      //   };

      //   const { Report } = require("fluentreports");
      //   const stream = require("stream");
      //   const pdfStream = new stream.PassThrough();

      //   // Create report with A4 page size
      //   const report = new Report(pdfStream, {
      //     paper: "A4",
      //     margins: { top: 40, left: 40, right: 40, bottom: 40 },
      //   });

      //   // Header Section
      //   report.pageHeader((rpt) => {
      //     // Title
      //     rpt.print("Expense Details", { x: 40, y: 40, fontSize: 20, bold: true });
      //     rpt.print("View and manage expense information", { x: 40, y: 65, fontSize: 12, color: "gray" });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 85, y2: 85 });

      //     // Left Section - Expense Information
      //     rpt.print("Expense Information", { x: 40, y: 105, fontSize: 16, bold: true });

      //     // Information Grid
      //     const startY = 140;
      //     const labelX = 40;
      //     const valueX = 200;
      //     const lineHeight = 35;

      //     // Number
      //     rpt.print("Number:", { x: labelX, y: startY, fontSize: 12, color: "gray" });
      //     rpt.print(formattedExpenseNumber, { x: valueX, y: startY, fontSize: 12 });

      //     // Date
      //     rpt.print("Date:", { x: labelX, y: startY + lineHeight, fontSize: 12, color: "gray" });
      //     rpt.print(formatDate(expense.date), { x: valueX, y: startY + lineHeight, fontSize: 12 });

      //     // Category
      //     rpt.print("Category:", { x: labelX, y: startY + lineHeight * 2, fontSize: 12, color: "gray" });
      //     rpt.print(expense.category, { x: valueX, y: startY + lineHeight * 2, fontSize: 12 });

      //     // Beneficiary
      //     rpt.print("Beneficiary:", { x: labelX, y: startY + lineHeight * 3, fontSize: 12, color: "gray" });
      //     rpt.print(expense.beneficiary, { x: valueX, y: startY + lineHeight * 3, fontSize: 12 });

      //     // Status
      //     rpt.print("Status:", { x: labelX, y: startY + lineHeight * 4, fontSize: 12, color: "gray" });
      //     rpt.print(expense.status, { x: valueX, y: startY + lineHeight * 4, fontSize: 12 });

      //     // Right Section - Summary
      //     rpt.print("Summary", { x: 400, y: 105, fontSize: 16, bold: true });
      //     rpt.print("Total Amount", { x: 400, y: 140, fontSize: 12, color: "gray" });
      //     rpt.print(formatCurrency(expense.grand_total), { x: 400, y: 165, fontSize: 20, bold: true });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: startY + lineHeight * 5, y2: startY + lineHeight * 5 });

      //     // Expense Items Section
      //     rpt.print("Expense Items", { x: 40, y: startY + lineHeight * 6, fontSize: 16, bold: true });

      //     // Items table header
      //     const tableY = startY + lineHeight * 7;
      //     rpt.print("Description", { x: 40, y: tableY, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 200, y: tableY, fontSize: 12, bold: true });
      //     rpt.print("Amount", { x: 330, y: tableY, fontSize: 12, bold: true });
      //     rpt.print("Total", { x: 460, y: tableY, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: tableY + 20, y2: tableY + 20 });
      //   });

      //   // Detail rows
      //   let currentY = 420;
      //   report.detail((rpt, data) => {
      //     // Description
      //     rpt.print(data.description || data.name, { x: 40, y: currentY, fontSize: 12 });

      //     // Quantity
      //     rpt.print(data.quantity || data.qty || "1", { x: 200, y: currentY, fontSize: 12 });

      //     // Amount (Unit Price)
      //     rpt.print(formatCurrency(data.amount || data.unit_price), { x: 330, y: currentY, fontSize: 12 });

      //     // Total
      //     const total = data.total || data.total_per_item || (data.amount || data.unit_price) * (data.quantity || data.qty || 1);
      //     rpt.print(formatCurrency(total), { x: 460, y: currentY, fontSize: 12 });

      //     currentY += 25;
      //   });

      //   // Set data source
      //   report.data(expense.items || []);

      //   // Footer with total
      //   report.finalSummary((rpt) => {
      //     const startY = currentY + 5;
      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: startY + 10, y2: currentY + 10 });

      //     // Total
      //     rpt.print("Total:", { x: 330, y: startY + 25, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(expense.grand_total), { x: 460, y: startY + 25, fontSize: 12, bold: true });
      //   });

      //   // Render the report
      //   report.render((err) => {
      //     if (err) {
      //       return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
      //     }
      //   });

      //   // Set response headers and pipe the PDF stream
      //   res.setHeader("Content-Type", "application/pdf");
      //   res.setHeader("Content-Disposition", `attachment; filename=EXPENSE_${formattedExpenseNumber}.pdf`);
      //   pdfStream.pipe(res);

      //   break;
      // }

      // Export Expense Pdf Endpoint
      case "exportExpensePdf": {
        if (method !== "GET") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use GET.",
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({
            error: true,
            message: "Authorization header is missing.",
          });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser(token);

        if (userError || !user) {
          return res.status(401).json({
            error: true,
            message: "Invalid or expired token.",
          });
        }

        const expenseId = req.query.id;
        if (!expenseId) {
          return res.status(400).json({
            error: true,
            message: "Missing expense id",
          });
        }

        const { data: expense, error: fetchError } = await supabase.from("expenses").select("*").eq("id", expenseId).single();

        if (fetchError || !expense) {
          return res.status(404).json({
            error: true,
            message: "Expense not found",
          });
        }

        // Format functions
        const formatCurrency = (amount) => `Rp ${Number(amount || 0).toLocaleString("id-ID")}`;
        const formatDate = (date) =>
          new Date(date).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "long",
            year: "numeric",
          });

        const formattedItems = Array.isArray(expense.items) ? expense.items : [];

        const itemsHtml = formattedItems
          .map((item, index) => {
            const price = Number(item.amount || 0); // ✅ ganti price → amount
            const quantity = Number(item.quantity || 1);
            const total = price * quantity;

            return `
      <tr>
        <td>${index + 1}</td>
        <td>${item.name || "-"}</td>
        <td>${quantity}</td>
        <td>${formatCurrency(price)}</td>
        <td>${formatCurrency(total)}</td>
      </tr>`;
          })
          .join("");

        const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          font-family: Arial, sans-serif;
          padding: 40px;
        }
        h1 {
          text-align: center;
          margin-bottom: 30px;
        }
        .info, .summary {
          width: 48%;
          display: inline-block;
          vertical-align: top;
        }
        .info p, .summary p {
          margin: 6px 0;
        }
        .badge {
          display: inline-block;
          padding: 4px 10px;
          background-color: #d4edda;
          color: #155724;
          border-radius: 12px;
          font-size: 0.9em;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 30px;
        }
        table, th, td {
          border: 1px solid #999;
        }
        th, td {
          padding: 10px;
          text-align: left;
        }
        th {
          background-color: #f0f0f0;
        }
        .total-row td {
          font-weight: bold;
          text-align: right;
        }
      </style>
    </head>
    <body>
      <h1>PT. Prabasena Baratawijaya - Expense</h1>

      <div class="info">
        <p><strong>Number:</strong> ${String(expense.number).padStart(5, "0")}</p>
        <p><strong>Date:</strong> ${formatDate(expense.date)}</p>
        <p><strong>Category:</strong> ${expense.category || "-"}</p>
        <p><strong>Beneficiary:</strong> ${expense.beneficiary || "-"}</p>
        <p><strong>Status:</strong> <span class="badge">${expense.status || "-"}</span></p>
      </div>

      <div class="summary" style="text-align:right;">
        <p><strong>Total Amount:</strong></p>
        <h2>${formatCurrency(expense.grand_total)}</h2>
      </div>

      <h2 style="margin-top: 40px;">Expense Items</h2>
      <table>
        <thead>
          <tr>
            <th>No</th>
            <th>Description</th>
            <th>Quantity</th>
            <th>Amount</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${
            itemsHtml ||
            `
            <tr>
              <td colspan="5" style="text-align: center;">No items available</td>
            </tr>`
          }
          <tr class="total-row">
            <td colspan="4">Total</td>
            <td>${formatCurrency(expense.grand_total)}</td>
          </tr>
        </tbody>
      </table>
    </body>
    </html>
  `;

        try {
          const jsreportInstance = await jsreport.init();
          const pdfResponse = await jsreportInstance.render({
            template: {
              content: html,
              engine: "none",
              recipe: "chrome-pdf",
            },
          });

          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `inline; filename="expense_${expenseId}.pdf"`);
          pdfResponse.stream.pipe(res);
        } catch (err) {
          console.error("PDF generation error:", err);
          res.status(500).json({
            error: true,
            message: "Failed to generate PDF.",
          });
        }

        break;
      }

      //   // Add Receive Payment for COA Endpoint
      //   case "addReceivePayment": {
      //     if (method !== "POST") {
      //       return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addReceivePayment." });
      //     }

      //     const authHeader = req.headers.authorization;
      //     if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

      //     const token = authHeader.split(" ")[1];
      //     const supabase = getSupabaseWithToken(token);

      //     const {
      //       data: { user },
      //       error: userError,
      //     } = await supabase.auth.getUser();

      //     if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

      //     // // Get user roles from database (e.g. 'profiles' or 'users' table)
      //     // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

      //     // if (profileError || !userProfile) {
      //     //   return res.status(403).json({
      //     //     error: true,
      //     //     message: "Unable to fetch user role or user not found",
      //     //   });
      //     // }

      //     // // Check if the user role is among those permitted
      //     // const allowedRoles = ["finance", "accounting", "manager", "admin"];
      //     // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
      //     //   return res.status(403).json({
      //     //     error: true,
      //     //     message: "Access denied. You are not authorized to perform this action.",
      //     //   });
      //     // }

      //     const { coa_code, description, transaction_date, debit, credit } = req.body;

      //     if (!coa_code || !transaction_date || (debit === 0 && credit === 0)) {
      //       return res.status(400).json({ error: true, message: "Missing required fields or invalid transaction values" });
      //     }

      //     const { error: insertError } = await supabase.from("receive_payment_transactions").insert([
      //       {
      //         user_id: user.id,
      //         coa_code,
      //         description,
      //         debit,
      //         credit,
      //         transaction_date,
      //         // number,
      //         // account_type,
      //         created_at: new Date().toISOString(),
      //         updated_at: new Date().toISOString(),
      //       },
      //     ]);

      //     if (insertError) {
      //       return res.status(500).json({ error: true, message: "Failed to insert receive payment transaction" });
      //     }

      //     return res.status(201).json({ error: false, message: "Receive payment added successfully" });
      //   }

      //   // Get Receive Payment for COA Endpoint
      //   case "getReceivePayment": {
      //     if (method !== "GET") {
      //       return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getReceivePayment." });
      //     }

      //     const authHeader = req.headers.authorization;
      //     if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

      //     const token = authHeader.split(" ")[1];
      //     const supabase = getSupabaseWithToken(token);

      //     const {
      //       data: { user },
      //       error: userError,
      //     } = await supabase.auth.getUser();

      //     if (userError || !user) {
      //       return res.status(401).json({ error: true, message: "Invalid or expired token" });
      //     }

      //     // // Get user roles from database (e.g. 'profiles' or 'users' table)
      //     // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

      //     // if (profileError || !userProfile) {
      //     //   return res.status(403).json({
      //     //     error: true,
      //     //     message: "Unable to fetch user role or user not found",
      //     //   });
      //     // }

      //     // // Check if the user role is among those permitted
      //     // const allowedRoles = ["finance", "accounting", "manager", "admin"];
      //     // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
      //     //   return res.status(403).json({
      //     //     error: true,
      //     //     message: "Access denied. You are not authorized to perform this action.",
      //     //   });
      //     // }

      //     const { data, error } = await supabase
      //       .from("receive_payment_transactions")
      //       .select(
      //         `
      //   id,
      //   user_id,
      //   coa_code,
      //   description,
      //   transaction_date,
      //   debit,
      //   credit,
      //   created_at,
      //   updated_at,
      //   chart_of_accounts (
      //     id,
      //     name,
      //     code
      //   )
      // `
      //       )
      //       .order("transaction_date", { ascending: false });

      //     if (error) {
      //       return res.status(500).json({ error: true, message: "Failed to fetch receive payments" });
      //     }

      //     // Optional formatting (e.g. format tanggal ke ID locale)
      //     const formattedData = data.map((item) => ({
      //       id: item.id,
      //       user_id: item.user_id,
      //       coa_code: item.coa_code,
      //       description: item.description,
      //       debit: item.debit,
      //       credit: item.credit,
      //       transaction_date: new Date(item.transaction_date).toLocaleDateString("id-ID"),
      //       created_at: item.created_at,
      //       updated_at: item.updated_at,
      //       coa: item.chart_of_accounts
      //         ? {
      //             id: item.chart_of_accounts.id,
      //             name: item.chart_of_accounts.name,
      //             code: item.chart_of_accounts.code,
      //           }
      //         : null,
      //     }));

      //     return res.status(200).json({ error: false, data: formattedData });
      //   }

      // Non-existent Endpoint
      default:
        return res.status(404).json({ error: true, message: "Endpoint not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: true, message: error.message || "Unexpected server error" });
  }
};
