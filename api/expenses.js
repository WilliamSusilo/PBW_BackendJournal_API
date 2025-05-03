const { getSupabaseWithToken } = require("../lib/supabaseClient");

module.exports = async (req, res) => {
  const { method, query } = req;
  const body = req.body;
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

        const { date, category, beneficiary, status, items } = req.body;

        if (!date || !category || !beneficiary || !status || !items || items.length === 0) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const requestDate = new Date(date);
        const requestMonth = requestDate.getMonth() + 1; // 0-based
        const requestYear = requestDate.getFullYear();

        // Generate prefix for this month: YYYYMM
        const prefix = `${requestYear}${String(requestMonth).padStart(2, "0")}`;
        const prefixInt = parseInt(prefix + "0", 10); // Example = 2025040
        const nextPrefixInt = parseInt(prefix + "9999", 10); // Upper limit (assume maximum 4 digit counter)

        const { data: latestExpense, error: fetchError } = await supabase.from("expenses").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest expense number: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (latestExpense && latestExpense.length > 0) {
          const lastNumber = latestExpense[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10); // Extract counter after prefix
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

        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

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

        const { id } = req.body;
        if (!id) return res.status(400).json({ error: true, message: "Expense ID is required" });

        const { data, error } = await supabase.from("expenses").update({ status: "Paid" }).eq("id", id).select();

        console.log("ID to update:", id);

        if (error) return res.status(500).json({ error: true, message: "Failed to approve expense: " + error.message });

        if (!data || data.length === 0) {
          return res.status(404).json({ error: true, message: "Expense not found with the given ID" });
        }

        return res.status(200).json({ error: false, message: "Expense approved successfully" });
      }

      // Delete Endpoint
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

        const { status } = req.query;

        let query = supabase.from("expenses").select("*").eq("user_id", user.id);

        if (status) query = query.eq("status", status);

        query = query.order("date", { ascending: false });

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

        const today = new Date();
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);

        // Fetch all expenses for the user
        const { data: expenses, error: fetchError } = await supabase.from("expenses").select("date, grand_total").eq("user_id", user.id);

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

      // Non-existent Endpoint
      default:
        return res.status(404).json({ error: true, message: "Endpoint not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: true, message: error.message || "Unexpected server error" });
  }
};
