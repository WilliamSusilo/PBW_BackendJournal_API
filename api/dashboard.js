const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");
const formidable = require("formidable");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE"],
  origin: ["http://localhost:8080", "http://192.168.100.3:8080", "https://preview--prabaraja-webapp.lovable.app", "https://44228f79-5a06-42bd-a4cf-7472726b027d.lovableproject.com", "https://prabaraja-webapp.vercel.app"],
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

function validateJournalDetails(details) {
  if (!Array.isArray(details) || details.length === 0) {
    return { ok: false, message: "journal_details must be a non-empty array" };
  }

  let totalDebit = 0;
  let totalCredit = 0;

  for (let i = 0; i < details.length; i++) {
    const line = details[i];

    // Check account_code or account_id
    if (!line.account_code && !line.account_id) {
      return { ok: false, message: `journal_details[${i}] must have account_code or account_id` };
    }

    // Check numeric debit/credit
    const debit = Number(line.debit) || 0;
    const credit = Number(line.credit) || 0;

    if (debit < 0 || credit < 0) {
      return { ok: false, message: `journal_details[${i}] has negative debit or credit` };
    }

    // Must not both be > 0
    if (debit > 0 && credit > 0) {
      return { ok: false, message: `journal_details[${i}] cannot have both debit and credit > 0` };
    }

    totalDebit += debit;
    totalCredit += credit;
  }

  return {
    ok: true,
    computedDebit: totalDebit,
    computedCredit: totalCredit,
  };
}

// Function to generate the next journal code
async function getNextJournalCode(supabase, providedDate, providedCode) {
  try {
    // If code is provided, use it directly
    if (providedCode) return providedCode;

    // Fetch the latest journal_code from Supabase
    const { data, error } = await supabase.from("journal_of_COA").select("journal_code").order("created_at", { ascending: false }).limit(1);

    if (error) {
      console.error("Error fetching last journal code:", error);
      throw new Error("Failed to fetch last journal code");
    }

    let nextNumber = 1; // Default if no data exists
    if (data && data.length > 0 && data[0].journal_code) {
      const lastCode = data[0].journal_code; // Example: JRN-2025-0003
      const lastNumber = parseInt(lastCode.split("-").pop(), 10);
      if (!isNaN(lastNumber)) {
        nextNumber = lastNumber + 1;
      }
    }

    // Year from provided date (default current year)
    const year = providedDate ? new Date(providedDate).getFullYear() : new Date().getFullYear();

    // Format: JRN-YYYY-000X
    return `JRN-${year}-${String(nextNumber).padStart(4, "0")}`;
  } catch (err) {
    console.error("Error in getNextJournalCode:", err.message);
    throw new Error("Unable to generate next journal code");
  }
}

/* ----------------------
   Helper utilities
   ---------------------- */

const parseTrailingNumber = (code) => {
  // for level3 suffix like "100101-12" => { base: "100101", suffix: 12 }
  if (!code || typeof code !== "string") return null;
  const m = code.match(/^(.+?)-(\d+)\s*$/);
  if (!m) return null;
  return { base: m[1], suffix: parseInt(m[2], 10) };
};

const ensureAuth = async (req, res) => {
  const method = req.method;
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: true, message: "No authorization header provided" });
    return null;
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ error: true, message: "No authorization token provided" });
    return null;
  }
  const supabase = getSupabaseWithToken(token);
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    res.status(401).json({ error: true, message: "Invalid or expired token" });
    return null;
  }
  return { supabase, user, method };
};

/**
 * getNextAccountCodeByLevel:
 * - level 1 => 6-digit numeric starting 100100
 * - level 2 => numeric child of parent (parentCode must exist & be level 1) => next = max child + 1 or parent+1
 * - level 3 => parentCode must be level 2 (sub-parent) => codes like "100101-1" -> next suffix
 *
 * Assumptions: chart_of_accounts table has fields: account_code (string), level (integer), parent_code (string|null)
 */
const getNextAccountCodeByLevel = async (supabase, level, parentCode = null) => {
  if (![1, 2, 3].includes(Number(level))) {
    throw new Error("Invalid level for account code generation");
  }

  if (Number(level) === 1) {
    // find max 6-digit numeric account_code for level 1 (no dash)
    const { data: allCodes, error } = await supabase.from("chart_of_accounts").select("account_code").filter("account_code", "not.ilike", "%-%"); // try to avoid dashed codes

    if (error) throw new Error("Failed to fetch existing account codes: " + error.message);

    let maxNum = null;
    for (const r of allCodes || []) {
      const code = (r.account_code || "").trim();
      if (/^\d{6}$/.test(code)) {
        const n = parseInt(code, 10);
        if (maxNum === null || n > maxNum) maxNum = n;
      }
    }

    if (maxNum === null) return "100100";
    return String(maxNum + 1).padStart(6, "0");
  }

  if (Number(level) === 2) {
    if (!parentCode) throw new Error("parentCode is required for level 2 generation");

    // get parent to ensure exists
    const { data: parent, error: pErr } = await supabase.from("chart_of_accounts").select("account_code, level").eq("account_code", parentCode).limit(1).single();

    if (pErr || !parent) throw new Error("Parent account not found");
    if (Number(parent.level) !== 1) throw new Error("Parent account is not level 1");

    // find existing children (level=2) with parent_code = parentCode and determine max numeric code (6-digit)
    const { data: children, error: cErr } = await supabase.from("chart_of_accounts").select("account_code").eq("parent_code", parentCode).eq("level", 2);

    if (cErr) throw new Error("Failed to fetch children: " + cErr.message);

    let maxNum = null;
    for (const row of children || []) {
      const code = (row.account_code || "").trim();
      if (/^\d{6}$/.test(code)) {
        const n = parseInt(code, 10);
        if (maxNum === null || n > maxNum) maxNum = n;
      }
    }

    if (maxNum === null) {
      // first child => parent + 1
      const pNum = parseInt(parentCode, 10);
      return String(pNum + 1).padStart(6, "0");
    }
    return String(maxNum + 1).padStart(6, "0");
  }

  // level 3
  if (Number(level) === 3) {
    if (!parentCode) throw new Error("parentCode is required for level 3 generation");

    // parentCode must exist and be level=2
    const { data: parent, error: pErr } = await supabase.from("chart_of_accounts").select("account_code, level").eq("account_code", parentCode).limit(1).single();

    if (pErr || !parent) throw new Error("Sub-parent account not found");
    if (Number(parent.level) !== 2) throw new Error("Sub-parent account is not level 2");

    // find existing codes that begin with `${parentCode}-`
    const likePattern = `${parentCode}-%`;
    const { data: matches, error: mErr } = await supabase.from("chart_of_accounts").select("account_code").ilike("account_code", likePattern);

    if (mErr) throw new Error("Failed to fetch level3 children: " + mErr.message);

    let maxSuffix = 0;
    for (const row of matches || []) {
      const parsed = parseTrailingNumber(row.account_code);
      if (parsed && parsed.prefix === parentCode) {
        const s = parsed.number || parsed.suffix || 0; // fallback
        if (s > maxSuffix) maxSuffix = s;
      } else {
        // if format is parentCode-N
        const m = (row.account_code || "").match(new RegExp(`^${parentCode}-(\\d+)$`));
        if (m) {
          const s2 = parseInt(m[1], 10);
          if (s2 > maxSuffix) maxSuffix = s2;
        }
      }
    }

    return `${parentCode}-${maxSuffix + 1}`;
  }
};

/* ----------------------
   Body parsing helper (safe for Node)
   ---------------------- */
const parseRequestBody = (req) => {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // safety: limit body size (optional)
      if (data.length > 1e7) {
        // ~10MB
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data ? data : "{}"));
    req.on("error", reject);
  });
};

module.exports = async (req, res) => {
  await runMiddleware(req, res, cors);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { method, headers, query } = req;
  let body = {};
  let files = {};
  let action = method === "GET" ? query.action : null;

  if (method !== "GET" && headers["content-type"]?.includes("multipart/form-data")) {
    console.log("=== FORMIDABLE PARSING DEBUG ===");
    console.log("Content-Type:", headers["content-type"]);
    console.log("Method:", method);

    const form = new formidable.IncomingForm({
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      multiples: true,
    });

    try {
      const { fields, files: parsedFiles } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          console.log("Formidable parse callback:");
          console.log("Error:", err);
          console.log("Fields:", fields);
          console.log("Files:", files);
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      console.log("Parsed fields:", fields);
      console.log("Parsed files:", parsedFiles);

      // Normalize fields so they are not arrays
      for (const key in fields) {
        body[key] = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
      }

      files = parsedFiles;
      action = body.action;

      // Save to req so it can be used in handler
      req.body = body;
      req.files = files;
      console.log("Final req.body:", req.body);
      console.log("Final req.files:", req.files);
      console.log("===============================");
    } catch (err) {
      console.error("Formidable parsing error:", err);
      return res.status(400).json({ error: true, message: "Error parsing form-data: " + err.message });
    }
  } else if (method !== "GET") {
    body = req.body;
    action = body.action;
  }

  try {
    switch (action) {
      // Summary Finance Endpoint
      case "summaryFinance": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for summaryFinance." });
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

        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const previousMonthStart = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
        const previousMonthEnd = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0);

        // Get data from sales
        const { data: sales, error: salesError } = await supabase.from("sales").select("invoice_date, grand_total");

        if (salesError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sales: " + salesError.message });
        }

        // Get data from bank_receive_transactions
        const { data: payments, error: paymentsError } = await supabase.from("bank_receive_transactions").select("date_received, amount");

        if (paymentsError) {
          return res.status(500).json({ error: true, message: "Failed to fetch payment transactions: " + paymentsError.message });
        }

        // Calculate the total sales dan payments
        const totalSalesCurrentMonth = sales
          .filter((sale) => {
            const d = new Date(sale.invoice_date);
            return d >= currentMonthStart && d <= currentMonthEnd;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const totalSalesPreviousMonth = sales
          .filter((sale) => {
            const d = new Date(sale.invoice_date);
            return d >= previousMonthStart && d <= previousMonthEnd;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const paymentsCurrentMonth = payments
          .filter((p) => {
            const d = new Date(p.date_received);
            return d >= currentMonthStart && d <= currentMonthEnd;
          })
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        const paymentsPreviousMonth = payments
          .filter((p) => {
            const d = new Date(p.date_received);
            return d >= previousMonthStart && d <= previousMonthEnd;
          })
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        // Generate monthly data for the past 6 months
        const monthlyData = [];

        for (let i = 5; i >= 0; i--) {
          const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const start = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
          const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);

          const monthName = start.toLocaleString("default", { month: "long" });

          const monthlySales = sales
            .filter((sale) => {
              const d = new Date(sale.invoice_date);
              return d >= start && d <= end;
            })
            .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

          const monthlyPayments = payments
            .filter((p) => {
              const d = new Date(p.date_received);
              return d >= start && d <= end;
            })
            .reduce((sum, p) => sum + (p.amount || 0), 0);

          const profit = Math.max(monthlySales - monthlyPayments, 0);
          const loss = Math.max(monthlyPayments - monthlySales, 0);

          monthlyData.push({
            month: monthName,
            profit,
            loss,
          });
        }

        return res.status(200).json({
          error: false,
          data: {
            monthlyData,
            currentMonthSales: totalSalesCurrentMonth,
            previousMonthSales: totalSalesPreviousMonth,
            currentMonthPayments: paymentsCurrentMonth,
            previousMonthPayments: paymentsPreviousMonth,
          },
        });
      }

      //   Summary Profit Loss Endpoint
      case "summaryProfitLoss": {
        if (method !== "GET") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use GET for summaryProfitLoss.",
          });
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

        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();

        const { data: sales, error: salesError } = await supabase.from("sales").select("invoice_date, grand_total");

        if (salesError) {
          return res.status(500).json({
            error: true,
            message: "Failed to fetch sales: " + salesError.message,
          });
        }

        const { data: purchases, error: purchasesError } = await supabase.from("invoices").select("date, grand_total");

        if (purchasesError) {
          return res.status(500).json({
            error: true,
            message: "Failed to fetch purchases: " + purchasesError.message,
          });
        }

        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

        const result = months.map((month, index) => ({
          month,
          profit: 0,
          loss: 0,
        }));

        sales.forEach((sale) => {
          const d = new Date(sale.invoice_date);
          if (d.getFullYear() === currentYear) {
            const monthIndex = d.getMonth(); // 0 = Jan
            result[monthIndex].profit += sale.grand_total || 0;
          }
        });

        purchases.forEach((purchase) => {
          const d = new Date(purchase.date);
          if (d.getFullYear() === currentYear) {
            const monthIndex = d.getMonth();
            result[monthIndex].loss += purchase.grand_total || 0;
          }
        });

        return res.status(200).json({
          error: false,
          year: currentYear,
          data: result,
        });
      }

      //   Get COA
      case "getCOA": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for summaryFinance." });
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

        const now = new Date();
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const previousMonthStart = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), 1);
        const previousMonthEnd = new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0);

        // Get data from sales
        const { data: sales, error: salesError } = await supabase.from("sales").select("invoice_date, grand_total");

        if (salesError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sales: " + salesError.message });
        }

        // Get data from bank_receive_transactions
        const { data: payments, error: paymentsError } = await supabase.from("bank_receive_transactions").select("date_received, amount");

        if (paymentsError) {
          return res.status(500).json({ error: true, message: "Failed to fetch payment transactions: " + paymentsError.message });
        }

        // Calculate the total sales dan payments
        const totalSalesCurrentMonth = sales
          .filter((sale) => {
            const d = new Date(sale.invoice_date);
            return d >= currentMonthStart && d <= currentMonthEnd;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const totalSalesPreviousMonth = sales
          .filter((sale) => {
            const d = new Date(sale.invoice_date);
            return d >= previousMonthStart && d <= previousMonthEnd;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const paymentsCurrentMonth = payments
          .filter((p) => {
            const d = new Date(p.date_received);
            return d >= currentMonthStart && d <= currentMonthEnd;
          })
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        const paymentsPreviousMonth = payments
          .filter((p) => {
            const d = new Date(p.date_received);
            return d >= previousMonthStart && d <= previousMonthEnd;
          })
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            total_sales_current_month: totalSalesCurrentMonth,
            total_sales_previous_month: totalSalesPreviousMonth,
            payments_received_current_month: paymentsCurrentMonth,
            payments_received_previous_month: paymentsPreviousMonth,
          },
        });
      }

      // ----------------------------- COA Feature -----------------------------
      // Add New Account for COA Endpoint
      case "addNewAccountCOA": {
        if (req.method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addNewAccountCOA." });
        }

        const auth = await ensureAuth(req, res);
        if (!auth) return;
        const { supabase, user } = auth;

        // Expected Fields
        const { name, account_code: provided_code, level, parent_code, parent_id, category, tax, bank_name, entry_balance, description, user_access, lock_option, detail_type, detail_desc } = body;

        // Minimal Validation
        if (!name || !level || !category) {
          return res.status(400).json({ error: true, message: "Missing required fields: name, level, category" });
        }

        const lvl = Number(level);
        if (![1, 2, 3].includes(lvl)) {
          return res.status(400).json({ error: true, message: "Invalid level. Allowed values: 1, 2, 3" });
        }

        // Detail Type & Detail Desc Validation
        const validDetailTypes = ["Parent Account", "Sub-Parent Account", "Sub-Child Account"];
        if (!detail_type || !validDetailTypes.includes(detail_type)) {
          return res.status(400).json({ error: true, message: "Invalid detail_type. Allowed: Parent Account, Sub-Parent Account, Sub-Child Account" });
        }

        // Mapping for detail_type --> level
        const levelTypeMap = {
          1: "Parent Account",
          2: "Sub-Parent Account",
          3: "Sub-Child Account",
        };
        if (levelTypeMap[lvl] !== detail_type) {
          return res.status(400).json({ error: true, message: `Level ${lvl} must use detail_type "${levelTypeMap[lvl]}"` });
        }

        // Validasi detail_desc sesuai detail_type
        if (detail_type === "Parent Account") {
          if (detail_desc) {
            return res.status(400).json({ error: true, message: "detail_desc must be null for Parent Account" });
          }
        }

        if (detail_type === "Sub-Parent Account") {
          const { data: parents, error: parentErr } = await supabase.from("chart_of_accounts").select("account_code").eq("level", 1).eq("category", category);
          if (parentErr) return res.status(500).json({ error: true, message: "Failed to fetch parent accounts" });

          const parentCodes = parents.map((p) => p.account_code);
          if (!parentCodes.includes(detail_desc)) {
            return res.status(400).json({ error: true, message: "detail_desc must be one of existing Parent Account codes in this category" });
          }
        }

        if (detail_type === "Sub-Child Account") {
          const { data: subParents, error: subParentErr } = await supabase.from("chart_of_accounts").select("account_code").eq("level", 2).eq("category", category);
          if (subParentErr) return res.status(500).json({ error: true, message: "Failed to fetch sub-parent accounts" });

          const subParentCodes = subParents.map((sp) => sp.account_code);
          if (!subParentCodes.includes(detail_desc)) {
            return res.status(400).json({ error: true, message: "detail_desc must be one of existing Sub-Parent Account codes in this category" });
          }
        }

        if (detail_type === "Sub-Parent Account") {
          const { data: parents, error: parentErr } = await supabase.from("chart_of_accounts").select("account_code, lock_option").eq("level", 1).eq("category", category);

          if (parentErr) return res.status(500).json({ error: true, message: "Failed to fetch parent accounts" });

          const parent = parents.find((p) => p.account_code === detail_desc);
          if (!parent) {
            return res.status(400).json({ error: true, message: "detail_desc must be one of existing Parent Account codes in this category" });
          }

          // Extra: reject locked parent
          if (parent.lock_option) {
            return res.status(403).json({
              error: true,
              message: `Parent account ${detail_desc} is locked and cannot have a new Sub-Parent Account.`,
            });
          }
        }

        if (detail_type === "Sub-Child Account") {
          const { data: subParents, error: subParentErr } = await supabase.from("chart_of_accounts").select("account_code, lock_option").eq("level", 2).eq("category", category);

          if (subParentErr) return res.status(500).json({ error: true, message: "Failed to fetch sub-parent accounts" });

          const subParent = subParents.find((sp) => sp.account_code === detail_desc);
          if (!subParent) {
            return res.status(400).json({ error: true, message: "detail_desc must be one of existing Sub-Parent Account codes in this category" });
          }

          // Extra: reject locked sub-parent
          if (subParent.lock_option) {
            return res.status(403).json({
              error: true,
              message: `Sub-parent account ${detail_desc} is locked and cannot have a new Sub-Child Account.`,
            });
          }
        }

        // ==== VALIDASI PARENT CODE ====
        if (lvl === 1 && parent_code) {
          return res.status(400).json({ error: true, message: "parent_code must be null for level 1 (Parent)" });
        }
        if ((lvl === 2 || lvl === 3) && !parent_code) {
          return res.status(400).json({ error: true, message: "parent_code is required for level 2 and 3" });
        }

        if (lvl === 2) {
          const { data: parent, error: pErr } = await supabase.from("chart_of_accounts").select("id, account_code, level").eq("account_code", parent_code).limit(1).single();
          if (pErr || !parent) return res.status(400).json({ error: true, message: "Parent account not found for level 2" });
          if (Number(parent.level) !== 1) return res.status(400).json({ error: true, message: "parent_code must reference a level 1 account" });
        }
        if (lvl === 3) {
          const { data: parent, error: pErr } = await supabase.from("chart_of_accounts").select("id, account_code, level").eq("account_code", parent_code).limit(1).single();
          if (pErr || !parent) return res.status(400).json({ error: true, message: "Sub-parent account not found for level 3" });
          if (Number(parent.level) !== 2) return res.status(400).json({ error: true, message: "parent_code must reference a level 2 account" });
        }

        // ==== VALIDASI BANK_NAME UNTUK CASH & BANK (WAJIB HANYA LEVEL 3) ====
        if (category.toLowerCase() === "cash & bank" && lvl === 3 && (!bank_name || bank_name.trim() === "")) {
          return res.status(400).json({ error: true, message: "bank_name is required for level 3 in Cash & Bank category" });
        }

        // ==== VALIDASI ACCOUNT_CODE ====
        let account_code = provided_code || null;
        if (account_code) {
          const { data: existing, error: fetchErr } = await supabase.from("chart_of_accounts").select("id").eq("account_code", account_code).limit(1);
          if (fetchErr) return res.status(500).json({ error: true, message: "Failed to check account_code uniqueness: " + fetchErr.message });
          if (existing && existing.length > 0) {
            return res.status(409).json({ error: true, message: "account_code already exists" });
          }

          if (lvl === 1 && !/^\d{6}$/.test(account_code)) {
            return res.status(400).json({ error: true, message: "level 1 account_code must be 6-digit numeric" });
          }
          if (lvl === 2 && !/^\d{6}$/.test(account_code)) {
            return res.status(400).json({ error: true, message: "level 2 account_code must be 6-digit numeric" });
          }
          if (lvl === 3 && !new RegExp(`^${parent_code}-\\d+$`).test(account_code)) {
            return res.status(400).json({ error: true, message: `level 3 account_code must start with "${parent_code}-<n>"` });
          }
        } else {
          try {
            account_code = await getNextAccountCodeByLevel(supabase, lvl, parent_code || null);
          } catch (e) {
            return res.status(500).json({ error: true, message: "Failed to compute account_code: " + e.message });
          }
        }

        // entry_balance numeric
        const entryBalanceNum = entry_balance ? Number(entry_balance) : 0;
        if (isNaN(entryBalanceNum)) {
          return res.status(400).json({ error: true, message: "entry_balance must be numeric" });
        }

        // build payload
        const payload = {
          user_id: user.id,
          name,
          account_code,
          level: lvl,
          parent_code: lvl === 1 ? null : parent_code,
          parent_id: lvl === 1 ? null : parent_id,
          category,
          tax: tax || null,
          bank_name: bank_name || null,
          entry_balance: entryBalanceNum,
          description: description || null,
          user_access: user_access || "All Users",
          lock_option: !!lock_option,
          detail_type,
          detail_desc: detail_desc || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        // insert
        const { data: inserted, error: insertErr } = await supabase.from("chart_of_accounts").insert([payload]).select().single();
        if (insertErr) {
          if (insertErr.message && insertErr.message.toLowerCase().includes("unique")) {
            return res.status(409).json({ error: true, message: "account_code conflict (possible concurrent insert). Try again." });
          }
          return res.status(500).json({ error: true, message: "Failed to create account: " + insertErr.message });
        }

        return res.status(201).json({ error: false, message: "Account added successfully", data: inserted });
      }

      // Edit Account for COA Endpoint
      case "editAccountCOA": {
        if (req.method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editAccountCOA." });
        }

        const auth = await ensureAuth(req, res);
        if (!auth) return;
        const { supabase, user } = auth;

        try {
          const { id } = req.body;
          if (!id) return res.status(400).json({ error: true, message: "Account id is required" });

          // Check if account exists
          const { data: existingAccount, error: fetchErr } = await supabase.from("chart_of_accounts").select("*").eq("id", id).limit(1).single();

          if (fetchErr || !existingAccount) {
            return res.status(404).json({ error: true, message: "Account not found" });
          }

          // Fields NOT allowed to change
          const protectedFields = ["account_code", "level", "parent_code", "parent_id", "category", "detail_type", "detail_desc"];

          for (const field of protectedFields) {
            if (field in req.body && req.body[field] !== existingAccount[field]) {
              return res.status(403).json({ error: true, message: `${field} cannot be changed once created` });
            }
          }

          // Prevent changing entry_balance if account has transactions
          if ("entry_balance" in req.body && req.body.entry_balance !== existingAccount.entry_balance) {
            const { data: hasTx } = await supabase.from("journal_entries").select("id").eq("account_code", existingAccount.account_code).limit(1);

            if (hasTx && hasTx.length > 0) {
              return res.status(403).json({
                error: true,
                message: "entry_balance cannot be changed directly. Use journal adjustment instead.",
              });
            }
          }

          // If category is "Cash & Bank", ensure bank_name is filled if provided
          if (existingAccount.category.toLowerCase() === "cash & bank") {
            if ("bank_name" in req.body && (!req.body.bank_name || req.body.bank_name.trim() === "")) {
              return res.status(400).json({ error: true, message: "bank_name is required for Cash & Bank accounts" });
            }
          }

          // Validate description length
          if ("description" in req.body && req.body.description && req.body.description.length > 500) {
            return res.status(400).json({ error: true, message: "description too long. Max 500 characters." });
          }

          // Only allow safe fields to be updated
          const allowedFields = ["name", "description", "tax", "bank_name", "user_access", "lock_option"];
          const updateFields = {};

          allowedFields.forEach((field) => {
            if (field in req.body) updateFields[field] = req.body[field];
          });

          updateFields.updated_at = new Date().toISOString();

          // Update
          const { data: updated, error: updateErr } = await supabase.from("chart_of_accounts").update(updateFields).eq("id", id).select().single();

          if (updateErr) {
            return res.status(500).json({ error: true, message: "Failed to update account: " + updateErr.message });
          }

          return res.status(200).json({ error: false, message: "Account updated successfully", data: updated });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Get All Account COA Endpoint
      case "getAccountCOA": {
        // Method GET
        if (req.method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getAccountCOA." });
        }

        // Authorization
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

        try {
          // Params from Postman Query (key=value in Params tab)
          const search = req.query.search?.toLowerCase();
          const pagination = parseInt(req.query.page) || 1;
          const limitValue = parseInt(req.query.limit) || 10;
          const from = (pagination - 1) * limitValue;
          const to = from + limitValue - 1;
          const category = req.query.category || null;

          let query = supabase.from("chart_of_accounts").select("*").order("created_at", { ascending: false }).range(from, to);

          // Filter category jika ada
          if (category) {
            query = query.eq("category", category);
          }

          // Search filter
          if (search) {
            const stringColumns = ["name", "description", "category", "tax"];
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            // Kalau search berupa angka, bisa cari di account_code
            if (!isNaN(search)) {
              ilikeConditions.push(`account_code.ilike.%${search}%`);
            }

            query = query.or(ilikeConditions.join(","));
          }

          const { data, error } = await query;

          if (error) {
            return res.status(500).json({ error: true, message: "Failed to fetch accounts: " + error.message });
          }

          return res.status(200).json({
            error: false,
            message: "Accounts retrieved successfully",
            page: pagination,
            limit: limitValue,
            total: data.length,
            data,
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Delete Account COA Endpoint
      case "deleteAccountCOA": {
        if (req.method !== "DELETE") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use DELETE for deleteAccountCOA.",
          });
        }

        const auth = await ensureAuth(req, res);
        if (!auth) return;
        const { supabase } = auth;

        try {
          const { id } = req.body;
          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Account ID is required",
            });
          }

          // Fetch account
          const { data: acct, error: fetchErr } = await supabase.from("chart_of_accounts").select("*").eq("id", id).limit(1).single();

          if (fetchErr || !acct) {
            return res.status(404).json({
              error: true,
              message: "Account not found",
            });
          }

          // Check if locked
          if (acct.lock_option) {
            return res.status(403).json({
              error: true,
              message: "This account is locked and cannot be deleted.",
            });
          }

          // Parent hierarchy check
          if (acct.detail_type === "Parent Account" && acct.level === 1) {
            const { data: subParents, error: subErr } = await supabase.from("chart_of_accounts").select("id").eq("detail_type", "Sub-Parent Account").eq("parent_id", acct.id).limit(1);

            if (subErr) {
              return res.status(500).json({
                error: true,
                message: "Failed to check sub-accounts: " + subErr.message,
              });
            }
            if (subParents && subParents.length > 0) {
              return res.status(403).json({
                error: true,
                message: "Cannot delete. This Parent Account has Sub-Parent Accounts linked.",
              });
            }
          }

          // Sub-parent hierarchy check
          if (acct.detail_type === "Sub-Parent Account" && acct.level === 2) {
            const { data: subChildren, error: subChildErr } = await supabase.from("chart_of_accounts").select("id").eq("detail_type", "Sub-Child Account").eq("parent_id", acct.id).limit(1);

            if (subChildErr) {
              return res.status(500).json({
                error: true,
                message: "Failed to check sub-child accounts: " + subChildErr.message,
              });
            }
            if (subChildren && subChildren.length > 0) {
              return res.status(403).json({
                error: true,
                message: "Cannot delete. This Sub-Parent Account has Sub-Child Accounts linked.",
              });
            }
          }

          // Ambil semua journal yang memiliki journal_details
          const { data: allJournals, error: journalErr } = await supabase.from("journal_of_COA").select("id, journal_code, journal_details").not("journal_details", "is", null);

          if (journalErr) {
            return res.status(500).json({
              error: true,
              message: "Failed to check journal references: " + journalErr.message,
            });
          }

          // Cek apakah ada journal yang menggunakan account_code atau account_id ini
          let foundJournals = [];
          if (allJournals && allJournals.length > 0) {
            for (const journal of allJournals) {
              if (journal.journal_details && Array.isArray(journal.journal_details)) {
                // Cek setiap item dalam journal_details array
                for (const detail of journal.journal_details) {
                  // Cek berdasarkan account_code atau account_id
                  if (detail.account_code === acct.account_code || detail.account_id === acct.id) {
                    foundJournals.push({
                      journal_id: journal.id,
                      journal_code: journal.journal_code,
                      account_code: detail.account_code,
                      account_id: detail.account_id,
                      debit: detail.debit,
                      credit: detail.credit,
                      description: detail.description,
                    });
                  }
                }
              }
            }
          }

          // Jika ditemukan journal yang menggunakan account_code atau account_id ini
          if (foundJournals.length > 0) {
            return res.status(403).json({
              error: true,
              message: `Account "${acct.name}" (${acct.account_code}) cannot be deleted because it is still in use in ${foundJournals.length} journal transactions!`,
              details: {
                account_code: acct.account_code,
                account_name: acct.account_name,
                account_id: acct.id,
                used_in_journals: foundJournals.length,
                sample_journals: foundJournals.slice(0, 3), // Tampilkan 3 contoh saja
                message: "Delete or edit any journals that use this account first before deleting the account!",
              },
            });
          }

          // Delete account
          const { error: deleteErr } = await supabase.from("chart_of_accounts").delete().eq("id", id);

          if (deleteErr) {
            return res.status(500).json({
              error: true,
              message: "Failed to delete account: " + deleteErr.message,
            });
          }

          return res.status(200).json({
            error: false,
            message: "Account deleted successfully",
          });
        } catch (e) {
          return res.status(500).json({
            error: true,
            message: "Server error: " + e.message,
          });
        }
      }

      // Add New Journal Endpoint
      case "addNewJournal": {
        if (req.method !== "POST")
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for addNewJournal.",
          });

        const auth = await ensureAuth(req, res);
        if (!auth) return;
        const { supabase, user } = auth;

        try {
          const { journal_code: providedJournalCode, date, tag, journal_details: journalDetailsRaw, memo, total_debit: providedTotalDebit, total_credit: providedTotalCredit } = req.body;

          // Parse journal_details if it's a string (from form-data)
          let journal_details;
          try {
            console.log("=== DEBUG JOURNAL DETAILS ===");
            console.log("Type of journalDetailsRaw:", typeof journalDetailsRaw);
            console.log("Value of journalDetailsRaw:", journalDetailsRaw);

            if (typeof journalDetailsRaw === "string") {
              journal_details = JSON.parse(journalDetailsRaw);
              console.log("Parsed journal_details:", journal_details);
            } else {
              journal_details = journalDetailsRaw;
              console.log("Using journal_details as is:", journal_details);
            }
            console.log("Final journal_details type:", typeof journal_details);
            console.log("Is Array:", Array.isArray(journal_details));
            console.log("=============================");
          } catch (parseError) {
            console.error("Parse error:", parseError);
            return res.status(400).json({
              error: true,
              message: "Invalid journal_details format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Handle file upload for attachment
          console.log("=== DEBUG FILE UPLOAD (addNewJournal) ===");
          console.log("req.files:", req.files);
          console.log("req.files?.attachment_url:", req.files?.attachment_url);

          const attachmentFileArray = req.files?.attachment_url;
          let attachment_url = null;

          // Upload attachment file if any
          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            // Handle both single file and array of files
            const attachmentFile = Array.isArray(attachmentFileArray) ? attachmentFileArray[0] : attachmentFileArray;

            console.log("Processed attachmentFile:", attachmentFile);
            console.log("File path:", attachmentFile?.filepath);
            console.log("Original filename:", attachmentFile?.originalFilename);
            console.log("MIME type:", attachmentFile?.mimetype);

            if (!attachmentFile || !attachmentFile.filepath) {
              console.log("❌ No valid attachment file found");
              return res.status(400).json({ error: true, message: "No attachment file uploaded or invalid file" });
            }

            try {
              const filePath = attachmentFile.filepath;
              console.log("Reading file from:", filePath);

              const fileBuffer = await fs.readFile(filePath);
              console.log("File buffer size:", fileBuffer.length);

              const fileExt = path.extname(attachmentFile.originalFilename || ".png");
              const fileName = `journalEntries/${user.id}_${Date.now()}${fileExt}`;
              console.log("Uploading to:", fileName);

              const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                contentType: attachmentFile.mimetype || "image/png",
                upsert: false,
              });

              if (uploadError) {
                console.error("❌ Upload error:", uploadError);
                return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
              }

              console.log("✅ Upload successful:", uploadData);
              attachment_url = uploadData.path;
              console.log("Final attachment_url:", attachment_url);
            } catch (fileError) {
              console.error("❌ File processing error:", fileError);
              return res.status(500).json({ error: true, message: "Failed to process attachment file: " + fileError.message });
            }
          } else {
            console.log("ℹ️ No attachment file provided");
          }
          console.log("=====================================");

          // Basic required
          if (!date || !journal_details) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields: date and journal_details are required",
            });
          }

          // Validate journal details lines
          const validation = validateJournalDetails(journal_details);
          if (!validation.ok) return res.status(400).json({ error: true, message: validation.message });

          const computedDebit = validation.computedDebit;
          const computedCredit = validation.computedCredit;

          // If user provided totals, ensure match computed
          if (providedTotalDebit !== undefined && Number(providedTotalDebit) !== computedDebit) {
            return res.status(400).json({
              error: true,
              message: "Provided total_debit does not match sum of journal_details",
            });
          }
          if (providedTotalCredit !== undefined && Number(providedTotalCredit) !== computedCredit) {
            return res.status(400).json({
              error: true,
              message: "Provided total_credit does not match sum of journal_details",
            });
          }

          // Must be balanced
          if (Math.abs(computedDebit - computedCredit) > 0.000001) {
            return res.status(400).json({
              error: true,
              message: "Debit and Credit must be balanced (sum must equal)",
            });
          }

          // Determine journal_code
          let journal_code;
          try {
            journal_code = await getNextJournalCode(supabase, date, providedJournalCode);
          } catch (e) {
            return res.status(500).json({
              error: true,
              message: "Failed to compute journal code: " + e.message,
            });
          }

          // ensure journal_code unique
          const { data: existingJ, error: ej } = await supabase.from("journal_of_COA").select("id").eq("journal_code", journal_code).limit(1);
          if (ej)
            return res.status(500).json({
              error: true,
              message: "Failed to validate journal_code uniqueness: " + ej.message,
            });
          if (existingJ && existingJ.length > 0)
            return res.status(409).json({
              error: true,
              message: "journal_code already exists",
            });

          // Validate all referenced accounts exist and are allowed
          for (const [i, line] of journal_details.entries()) {
            let accData;
            if (line.account_id) {
              const { data: acc, error: accErr } = await supabase.from("chart_of_accounts").select("id, lock_option, level, detail_type").eq("id", line.account_id).limit(1);
              if (accErr)
                return res.status(500).json({
                  error: true,
                  message: `Failed to verify account at journal_details[${i}]: ${accErr.message}`,
                });
              if (!acc || acc.length === 0)
                return res.status(400).json({
                  error: true,
                  message: `Account not found for journal_details[${i}] by account_id`,
                });
              accData = acc[0];
            } else if (line.account_code) {
              const { data: acc, error: accErr2 } = await supabase.from("chart_of_accounts").select("id, lock_option, level, detail_type").eq("account_code", line.account_code).limit(1);
              if (accErr2)
                return res.status(500).json({
                  error: true,
                  message: `Failed to verify account at journal_details[${i}]: ${accErr2.message}`,
                });
              if (!acc || acc.length === 0)
                return res.status(400).json({
                  error: true,
                  message: `Account not found for journal_details[${i}] by account_code`,
                });
              accData = acc[0];
            }

            // Extra: reject locked account
            if (accData.lock_option) {
              return res.status(403).json({
                error: true,
                message: `Account at journal_details[${i}] is locked and cannot be used in journal.`,
              });
            }

            // Extra: only allow level 3 (Sub Child Account)
            // if (accData.level !== 3) {
            //   return res.status(400).json({
            //     error: true,
            //     message: `Account at journal_details[${i}] is not a Sub Child Account (level 3). Only detail-level accounts can be used.`,
            //   });
            // }
          }

          // Insert
          const payload = {
            user_id: user.id,
            journal_code,
            date,
            tag: tag || null,
            journal_details, // store as JSONB array
            memo: memo || null,
            total_amount_debit: computedDebit,
            total_amount_credit: computedCredit,
            attachment_url: attachment_url || null,
            created_at: new Date(),
            updated_at: new Date(),
          };

          const { data: inserted, error: insertErr } = await supabase.from("journal_of_COA").insert([payload]).select().single();

          if (insertErr) {
            if (insertErr.message && insertErr.message.toLowerCase().includes("unique")) {
              return res.status(409).json({
                error: true,
                message: "journal_code conflict (possible concurrent insert). Try again.",
              });
            }
            return res.status(500).json({
              error: true,
              message: "Failed to create journal: " + insertErr.message,
            });
          }

          return res.status(201).json({
            error: false,
            message: "Journal added successfully",
            data: inserted,
          });
        } catch (e) {
          return res.status(500).json({
            error: true,
            message: "Server error: " + e.message,
          });
        }
      }

      // Edit Journal Endpoint
      case "editJournal": {
        if (req.method !== "PUT")
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use PUT for editJournal.",
          });

        const auth = await ensureAuth(req, res);
        if (!auth) return;
        const { supabase, user } = auth;

        try {
          // Destructure dengan alias agar konsisten dengan addNewJournal
          const { id, journal_code: newJournalCode, date, tag, journal_details: journalDetailsRaw, memo, total_debit: providedTotalDebit, total_credit: providedTotalCredit } = req.body;

          // Parse journal_details if it's a string (from form-data)
          let journal_details;
          if (journalDetailsRaw) {
            try {
              if (typeof journalDetailsRaw === "string") {
                journal_details = JSON.parse(journalDetailsRaw);
              } else {
                journal_details = journalDetailsRaw;
              }
            } catch (parseError) {
              return res.status(400).json({
                error: true,
                message: "Invalid journal_details format. Must be valid JSON array: " + parseError.message,
              });
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Journal ID is required",
            });
          }

          // Fetch existing journal
          const { data: journal, error: fetchErr } = await supabase.from("journal_of_COA").select("*").eq("id", id).limit(1).single();

          if (fetchErr || !journal) {
            return res.status(404).json({
              error: true,
              message: "Journal not found",
            });
          }

          // Handle file upload for attachment
          console.log("=== DEBUG FILE UPLOAD ===");
          console.log("req.files:", req.files);
          console.log("req.files?.attachment_url:", req.files?.attachment_url);

          const attachmentFileArray = req.files?.attachment_url;
          let attachment_url = journal.attachment_url; // Keep existing attachment if no new file uploaded

          // Upload attachment file if any
          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            // Handle both single file and array of files
            const attachmentFile = Array.isArray(attachmentFileArray) ? attachmentFileArray[0] : attachmentFileArray;

            console.log("Processed attachmentFile:", attachmentFile);
            console.log("File path:", attachmentFile?.filepath);
            console.log("Original filename:", attachmentFile?.originalFilename);
            console.log("MIME type:", attachmentFile?.mimetype);

            if (!attachmentFile || !attachmentFile.filepath) {
              console.log("No valid attachment file found");
              return res.status(400).json({ error: true, message: "No attachment file uploaded or invalid file" });
            }

            try {
              const filePath = attachmentFile.filepath;
              console.log("Reading file from:", filePath);

              const fileBuffer = await fs.readFile(filePath);
              console.log("File buffer size:", fileBuffer.length);

              const fileExt = path.extname(attachmentFile.originalFilename || ".png");
              const fileName = `journalEntries/${user.id}_${Date.now()}${fileExt}`;
              console.log("Uploading to:", fileName);

              const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                contentType: attachmentFile.mimetype || "image/png",
                upsert: false,
              });

              if (uploadError) {
                console.error("❌ Upload error:", uploadError);
                return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
              }

              console.log("✅ Upload successful:", uploadData);
              attachment_url = uploadData.path;
              console.log("Final attachment_url:", attachment_url);
            } catch (fileError) {
              console.error("❌ File processing error:", fileError);
              return res.status(500).json({ error: true, message: "Failed to process attachment file: " + fileError.message });
            }
          } else {
            console.log("ℹ️ No attachment file provided, keeping existing:", attachment_url);
          }
          console.log("==========================");

          let totalAmountDebit = providedTotalDebit;
          let totalAmountCredit = providedTotalCredit;

          // Jika journal_details diubah, validasi ulang seperti addNewJournal
          if (journal_details) {
            const validation = validateJournalDetails(journal_details);
            if (!validation.ok) {
              return res.status(400).json({
                error: true,
                message: validation.message,
              });
            }

            const computedDebit = validation.computedDebit;
            const computedCredit = validation.computedCredit;

            if (Math.abs(computedDebit - computedCredit) > 0.000001) {
              return res.status(400).json({
                error: true,
                message: "Debit and Credit must be balanced (sum must equal)",
              });
            }

            // Validate akun yang dipakai
            for (const [i, line] of journal_details.entries()) {
              let accData;

              if (line.account_id) {
                const { data: acc, error: accErr } = await supabase.from("chart_of_accounts").select("id, lock_option, level, detail_type").eq("id", line.account_id).limit(1);
                if (accErr) {
                  return res.status(500).json({
                    error: true,
                    message: `Failed to verify account at journal_details[${i}]: ${accErr.message}`,
                  });
                }
                if (!acc || acc.length === 0) {
                  return res.status(400).json({
                    error: true,
                    message: `Account not found for journal_details[${i}] by account_id`,
                  });
                }
                accData = acc[0];
              } else if (line.account_code) {
                const { data: acc, error: accErr2 } = await supabase.from("chart_of_accounts").select("id, lock_option, level, detail_type").eq("account_code", line.account_code).limit(1);
                if (accErr2) {
                  return res.status(500).json({
                    error: true,
                    message: `Failed to verify account at journal_details[${i}]: ${accErr2.message}`,
                  });
                }
                if (!acc || acc.length === 0) {
                  return res.status(400).json({
                    error: true,
                    message: `Account not found for journal_details[${i}] by account_code`,
                  });
                }
                accData = acc[0];
              } else {
                return res.status(400).json({
                  error: true,
                  message: `journal_details[${i}] must have either account_id or account_code`,
                });
              }

              if (accData.lock_option) {
                return res.status(403).json({
                  error: true,
                  message: `Account at journal_details[${i}] is locked and cannot be used in journal.`,
                });
              }

              if (accData.level !== 3) {
                return res.status(400).json({
                  error: true,
                  message: `Account at journal_details[${i}] is not a Sub Child Account (level 3). Only detail-level accounts can be used.`,
                });
              }
            }

            // Gunakan hasil hitungan terbaru
            totalAmountDebit = computedDebit;
            totalAmountCredit = computedCredit;
          }

          // Cek journal_code baru jika diubah
          if (newJournalCode && newJournalCode !== journal.journal_code) {
            const { data: same, error: cErr } = await supabase.from("journal_of_COA").select("id").eq("journal_code", newJournalCode).limit(1);
            if (cErr) {
              return res.status(500).json({
                error: true,
                message: "Failed to validate new journal_code: " + cErr.message,
              });
            }
            if (same && same.length > 0) {
              return res.status(409).json({
                error: true,
                message: "journal_code already exists",
              });
            }
          }

          // Siapkan payload update
          const updateFields = {
            journal_code: newJournalCode ?? journal.journal_code,
            date,
            tag,
            memo,
            attachment_url,
            total_amount_debit: totalAmountDebit,
            total_amount_credit: totalAmountCredit,
            journal_details: journal_details ?? journal.journal_details,
            updated_at: new Date(),
          };

          // Hapus key undefined agar tidak overwrite ke null
          Object.keys(updateFields).forEach((key) => updateFields[key] === undefined && delete updateFields[key]);

          // Update ke DB
          const { data: updated, error: updateErr } = await supabase.from("journal_of_COA").update(updateFields).eq("id", id).select().single();

          if (updateErr) {
            return res.status(500).json({
              error: true,
              message: "Failed to update journal: " + updateErr.message,
            });
          }

          return res.status(200).json({
            error: false,
            message: "Journal updated successfully",
            data: updated,
          });
        } catch (e) {
          return res.status(500).json({
            error: true,
            message: "Server error: " + e.message,
          });
        }
      }

      // Get All Journals Endpoint
      case "getJournalCOA": {
        if (req.method !== "GET") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use GET for getJournalCOA.",
          });
        }

        // Authorization
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

        try {
          // Query params
          const search = req.query.search?.toLowerCase();
          const pagination = parseInt(req.query.page) || 1;
          const limitValue = parseInt(req.query.limit) || 10;
          const from = (pagination - 1) * limitValue;
          const to = from + limitValue - 1;
          const dateFrom = req.query.date_from || null;
          const dateTo = req.query.date_to || null;

          // Base query
          let query = supabase.from("journal_of_COA").select("*").order("date", { ascending: false }).range(from, to);

          // Filter tanggal
          if (dateFrom) {
            query = query.gte("date", dateFrom);
          }
          if (dateTo) {
            query = query.lte("date", dateTo);
          }

          // Search filter
          if (search) {
            const stringColumns = ["journal_code", "tag", "memo"];
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
            query = query.or(ilikeConditions.join(","));
          }

          // Execute query
          const { data, error } = await query;

          if (error) {
            return res.status(500).json({ error: true, message: "Failed to fetch journals: " + error.message });
          }

          // Count total for pagination
          const { count, error: countError } = await supabase.from("journal_of_COA").select("*", { count: "exact", head: true });

          if (countError) {
            return res.status(500).json({ error: true, message: "Failed to count journals: " + countError.message });
          }

          return res.status(200).json({
            error: false,
            message: "Journals retrieved successfully",
            page: pagination,
            limit: limitValue,
            total: count,
            data,
          });
        } catch (e) {
          return res.status(500).json({
            error: true,
            message: "Server error: " + e.message,
          });
        }
      }

      // Delete Journal Endpoint
      case "deleteJournal": {
        if (req.method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteJournal." });
        }

        const auth = await ensureAuth(req, res);
        if (!auth) return;
        const { supabase, user } = auth;

        try {
          const { id } = req.body;
          if (!id) return res.status(400).json({ error: true, message: "Journal ID is required" });

          // Fetch journal row using columns that actually exist in your table
          const { data: journal, error: fetchErr } = await supabase.from("journal_of_COA").select("id, journal_code, user_id, created_at").eq("id", id).limit(1).single();

          if (fetchErr || !journal) {
            return res.status(404).json({ error: true, message: "Journal not found" });
          }

          // Ownership check (if your system stores user_id)
          // if (journal.user_id && journal.user_id !== user.id) {
          //   return res.status(403).json({ error: true, message: "You do not have permission to delete this journal" });
          // }

          // OPTIONAL: Check accounting period closure
          // If you have a table that tracks closed accounting periods, you should check here
          // Example pseudo-check (uncomment & adapt if you have such table):
          // const { data: closed, error: closedErr } = await supabase
          //   .from('accounting_periods')
          //   .select('id')
          //   .lte('end_date', journal.created_at)      // just an example rule
          //   .eq('is_closed', true)
          //   .limit(1);
          // if (closedErr) { /* handle error */ }
          // if (closed && closed.length > 0) return res.status(400).json({ error: true, message: 'Journal falls into a closed period and cannot be deleted' });

          // -------------- Check references in other tables --------------
          // Try to detect whether other modules reference this journal (safe-check).
          // If your project has known tables that reference journal_id, list them here.
          // const possibleRefTables = [
          //   "payments",
          //   "invoices",
          //   "general_ledger",
          //   "ledger_entries",
          //   "some_related_table", // <-- replace or remove as needed
          // ];

          // for (const table of possibleRefTables) {
          //   try {
          //     // attempt a safe query; if the table doesn't exist, supabase will return error -> ignore that table
          //     const { data: refs, error: refErr } = await supabase.from(table).select("id").eq("journal_id", id).limit(1);
          //     if (refErr) {
          //       // If error indicates table doesn't exist, skip; otherwise log and throw
          //       const msg = (refErr.message || "").toLowerCase();
          //       if (msg.includes("does not exist") || msg.includes("relation") || msg.includes("no such table")) {
          //         // table not present in this DB — ignore
          //         continue;
          //       } else {
          //         // unexpected error querying that table — fail fast
          //         console.warn(`Warning querying table ${table}:`, refErr);
          //         return res.status(500).json({ error: true, message: `Failed to check references in ${table}: ${refErr.message}` });
          //       }
          //     }
          //     if (refs && refs.length > 0) {
          //       return res.status(400).json({ error: true, message: `Journal is referenced in table "${table}" and cannot be deleted.` });
          //     }
          //   } catch (err) {
          //     // In case the supabase client throws (very unlikely), skip this table
          //     console.warn(`Skipping reference check for ${table} due to error:`, err.message || err);
          //     continue;
          //   }
          // }

          const { data: deleted, error: delErr } = await supabase.from("journal_of_COA").delete().eq("id", id).select().single();

          if (delErr) {
            return res.status(500).json({ error: true, message: "Failed to delete journal: " + delErr.message });
          }

          return res.status(200).json({
            error: false,
            message: `Journal ${journal.journal_code || id} deleted successfully`,
            data: deleted,
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      case "lockAccountCOA": {
        if (req.method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for lockAccountCOA." });
        }

        const auth = await ensureAuth(req, res);
        if (!auth) return;
        const { supabase } = auth;
        const { account_code, lock_option } = body;

        if (!account_code || typeof lock_option !== "boolean") {
          return res.status(400).json({ error: true, message: "Missing required fields: account_code (string) and lock_option (boolean)" });
        }

        // Take target account
        const { data: acct, error: fetchErr } = await supabase.from("chart_of_accounts").select("id, level, account_code").eq("account_code", account_code).single();

        if (fetchErr || !acct) {
          return res.status(404).json({ error: true, message: "Account not found" });
        }

        // Update main account
        const { error: updateErr } = await supabase.from("chart_of_accounts").update({ lock_option, updated_at: new Date().toISOString() }).eq("id", acct.id);

        if (updateErr) {
          return res.status(500).json({ error: true, message: "Failed to update account lock status" });
        }

        // Key inheritance
        if (acct.level === 1) {
          // Lock all children level 2 and 3
          await supabase.from("chart_of_accounts").update({ lock_option, updated_at: new Date().toISOString() }).ilike("parent_code", `${acct.account_code}%`);
        } else if (acct.level === 2) {
          // Lock all children level 3
          await supabase.from("chart_of_accounts").update({ lock_option, updated_at: new Date().toISOString() }).eq("parent_code", acct.account_code);
        }
        // Level 3 → no children, just update the account.

        return res.status(200).json({ error: false, message: `Account ${account_code} and its descendants lock_option updated to ${lock_option}` });
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
