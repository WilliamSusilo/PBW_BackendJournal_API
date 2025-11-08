const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");
const { tracingChannel } = require("diagnostics_channel");
const formidable = require("formidable");
const { request } = require("http");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE"],
  origin: ["http://localhost:8080", "http://192.168.100.3:8080", "https://prabaraja-webapp.vercel.app", "https://prabaraja-project.vercel.app"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

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

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

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
    const form = new formidable.IncomingForm({
      keepExtensions: true,
      maxFileSize: 10 * 1024 * 1024, // 10MB
      multiples: true,
    });

    try {
      const { fields, files: parsedFiles } = await new Promise((resolve, reject) => {
        form.parse(req, (err, fields, files) => {
          if (err) reject(err);
          else resolve({ fields, files });
        });
      });

      // Normalize fields so they are not arrays
      for (const key in fields) {
        body[key] = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
      }

      files = parsedFiles;
      action = body.action;

      // Save to req so it can be used in handler
      req.body = body;
      req.files = files;
    } catch (err) {
      return res.status(400).json({ error: true, message: "Error parsing form-data: " + err.message });
    }
  } else if (method !== "GET") {
    body = req.body;
    action = body.action;
  }

  try {
    switch (action) {
      // Add Billing Order Endpoint
      case "addNewBillingOrder": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addNewBillingOrder." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["finance", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          // Input id for connect with purchase order data
          let { id, vendor_name, order_date, number, type, memo, items: itemsRaw, installment_amount, installment_COA, payment_COA, installment_name, payment_name, vat_name, vat_COA } = req.body;

          // Check the installment options before continuing
          const { data: order, error: orderError } = await supabase
            .from("orders")
            .select("installment_option, tax_method, ppn_percentage, grand_total")
            .eq("id", id) // replace with the order ID you are processing
            .single();

          if (orderError || !order) {
            return res.status(404).json({
              error: true,
              message: "Order not found",
            });
          }

          // If installment_option = FALSE → error
          if (order.installment_option === false || order.installment_option === null) {
            return res.status(400).json({
              error: true,
              message: "You must first select the prepaid payment option before proceeding.",
            });
          }

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesBillingOrders/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id || !vendor_name || !order_date || !number || !itemsRaw || !installment_amount || !installment_COA || !payment_COA || !payment_COA || !installment_name || !payment_name || !vat_name || !vat_COA) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("billing_order").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch billing order numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The billing order number "${inputNumber}" has already been used. Please enter a new and unique billing order number that has not been used before.`,
            });
          }

          // Ambil nilai dari hasil query
          const { grand_total, tax_method, ppn_percentage } = order;

          // Pastikan persentase PPN valid
          const grandTotal = Number(grand_total) || 0;
          console.log("Ini grandTotal =", grandTotal);
          const ppnRate = Number(ppn_percentage) / 100;
          let dpp = 0;
          let ppn = 0;

          // Logika perhitungan sesuai kondisi tax_method dengan aturan special untuk ppn_percentage 11 atau 12
          const ppnPct = Number(ppn_percentage) || 0;
          let paid_amount = 0;

          if (tax_method === "Before Calculate") {
            if (ppnPct === 11) {
              // If ppn_percentage = 11, treat installment_amount as DPP
              dpp = Number(installment_amount) || 0;
              ppn = Math.round(ppnRate * dpp);
              paid_amount = Math.round(dpp - ppn);
            } else if (ppnPct === 12) {
              // If ppn_percentage = 12, use 11/12 * installment as DPP
              dpp = (11 / 12) * Number(installment_amount || 0);
              ppn = Math.round(ppnRate * dpp);
              paid_amount = Math.round(Number(installment_amount || 0) - ppn);
            } else {
              // Fallback: original behaviour (approximate)
              dpp = (11 / 12) * Number(installment_amount || 0);
              ppn = Math.round(ppnRate * dpp);
              paid_amount = Math.round(Number(installment_amount || 0) + ppn);
            }
          } else if (tax_method === "After Calculate") {
            if (ppnPct === 11) {
              // If ppn_percentage = 11, compute DPP by dividing by (1+ppnRate)
              dpp = Number(installment_amount || 0) / (1 + ppnRate);
              ppn = Math.round(ppnRate * dpp);
              paid_amount = Math.round(dpp - ppn);
            } else if (ppnPct === 12) {
              // If ppn_percentage = 12, use 11/12 * installment as DPP
              dpp = (11 / 12) * Number(installment_amount || 0);
              ppn = Math.round(ppnRate * dpp);
              paid_amount = Math.round(Number(installment_amount || 0) - ppn);
            } else {
              // Fallback to previous After Calculate behaviour
              dpp = Number(installment_amount || 0) / (1 + ppnRate);
              ppn = Math.round(ppnRate * dpp);
              paid_amount = Math.round(Number(installment_amount || 0) + ppn);
            }
          } else {
            return res.status(400).json({
              error: true,
              message: `Unknown tax method: ${tax_method}`,
            });
          }

          // Make journal entry
          const { data: journal, error: journalError } = await supabase
            .from("journal_entries")
            .insert({
              transaction_number: `ORD-${number}`,
              description: `Journal for Billing Order`,
              user_id: user.id,
              entry_date: new Date().toISOString().split("T")[0],
              created_at: new Date(),
            })
            .select()
            .single();

          if (journalError) {
            return res.status(500).json({
              error: true,
              message: "Failed to create journal entry: " + journalError.message,
            });
          }

          const lineEntries = [];

          // Debit Purchase Prepaid Vendor
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: installment_COA,
            description: installment_name,
            debit: installment_amount,
            credit: 0,
            user_id: user.id,
          });

          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: vat_COA,
            description: vat_name,
            debit: ppn,
            credit: 0,
            user_id: user.id,
          });

          // Credit Cash & Bank
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: payment_COA,
            description: payment_name,
            debit: 0,
            credit: paid_amount,
            user_id: user.id,
          });

          // Insert ke Supabase
          const { error: insertError } = await supabase.from("journal_entry_lines").insert(lineEntries);

          if (insertError) {
            return res.status(500).json({
              error: true,
              message: "Failed to insert journal lines: " + insertError.message,
            });
          }

          const { error } = await supabase.from("billing_order").insert([
            {
              user_id: user.id,
              vendor_name,
              order_date,
              number,
              type,
              memo,
              items: itemsRaw,
              installment_amount,
              installment_COA,
              payment_COA,
              installment_name,
              payment_name,
              vat_name,
              vat_COA,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (installment_amount <= 0) {
            return res.status(400).json({
              error: true,
              message: "Installment_amount must be a valid positive number",
            });
          }

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create billing summary: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Billing Order",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({
            error: false,
            message: "Billing summary created successfully",
            data: {
              journal,
              lines: lineEntries,
            },
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Add Billing Invoice Endpoint
      case "addNewBillingInvoice": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addNewBillingInvoice." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["finance", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          let { vendor_name, invoice_date, terms, grand_total, items: itemsRaw, payment_method, payment_COA, vendor_COA, type, number, status, memo, installment_amount, installment_type, due_date, payment_date, payment_amount } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesBillingInvoices/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!vendor_name || !invoice_date || !terms || !grand_total || !itemsRaw || !payment_method || !payment_COA || !vendor_COA || !type || !number || !status || !memo || !due_date || !payment_date) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("billing_invoice").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch billing summary numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The billing summary number "${inputNumber}" has already been used. Please enter a new and unique billing summary number that has not been used before.`,
            });
          }

          const { error } = await supabase.from("billing_invoice").insert([
            {
              user_id: user.id,
              vendor_name,
              invoice_date,
              terms,
              grand_total,
              items: itemsRaw,
              payment_method,
              payment_COA,
              vendor_COA,
              type,
              number,
              status,
              memo,
              installment_amount,
              installment_type,
              due_date,
              payment_date,
              payment_amount,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create billing summary: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Billing Invoice",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({
            error: false,
            message: "Billing summary created successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Add Invoice Endpoint
      case "addNewInvoice": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addInvoice." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["finance", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          let {
            type,
            date,
            number,
            approver,
            due_date,
            status,
            items: itemsRaw,
            tax_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            dpp,
            ppn,
            pph,
            grand_total,
            tags,
            memo,
            vendor_name,
            vendor_address,
            vendor_phone,
            terms,
            freight_in,
            insurance,
            vendor_COA,
            total,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesInvoices/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (
            !type ||
            !date ||
            !number ||
            !approver ||
            !due_date ||
            !status ||
            !items ||
            items.length === 0 ||
            !tax_method ||
            !ppn_percentage ||
            !pph_type ||
            !pph_percentage ||
            !dpp ||
            !ppn ||
            !pph ||
            !grand_total ||
            !vendor_name ||
            !vendor_address ||
            !vendor_phone ||
            !terms ||
            !freight_in ||
            !insurance ||
            !vendor_COA ||
            !total
          ) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          // const requestDate = new Date(date);
          // const month = requestDate.getMonth() + 1; // 0-based
          // const year = requestDate.getFullYear();

          // // Generate prefix for this month: YYYYMM
          // const prefix = `${year}${String(month).padStart(2, "0")}`;

          // // Fetch latest invoice number
          // const { data: latestInvoice, error: fetchError } = await supabase
          //   .from("invoices")
          //   .select("number")
          //   .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          //   .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          //   .order("number", { ascending: false })
          //   .limit(1);

          // if (fetchError) {
          //   return res.status(500).json({ error: true, message: "Failed to fetch latest invoice number: " + fetchError.message });
          // }

          // // Determine the next counter based on latest request
          // let counter = 1;
          // if (latestInvoice && latestInvoice.length > 0) {
          //   const lastNumber = latestInvoice[0].number.toString();
          //   const lastCounter = parseInt(lastNumber.slice(6), 10);
          //   counter = lastCounter + 1;
          // }

          // // Combine prefix + counter
          // const nextNumber = parseInt(`${prefix}${counter}`, 10);

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("invoices").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch invoice numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The invoice number "${inputNumber}" has already been used. Please enter a new and unique invoice number that has not been used before.`,
            });
          }

          // Update items with total_per_item
          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const price = Number(item.price) || 0;
            const total_per_item = qty * price;

            return {
              ...item,
              total_per_item,
            };
          });

          // const dpp = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          // // Calculate PPN and PPh
          // const ppn = (dpp * (ppn_percentage || 0)) / 100;
          // const pph = (dpp * (pph_percentage || 0)) / 100;

          // Final grand total
          // const grand_total = dpp + ppn - pph;

          const { error } = await supabase.from("invoices").insert([
            {
              user_id: user.id,
              type,
              date,
              number,
              approver,
              due_date,
              status,
              items: updatedItems,
              tax_method,
              ppn_percentage,
              pph_type,
              pph_percentage,
              dpp,
              ppn,
              pph,
              grand_total,
              tags,
              memo,
              vendor_name,
              vendor_address,
              vendor_phone,
              terms,
              freight_in,
              insurance,
              vendor_COA,
              total,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create invoice: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Invoice",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({
            error: false,
            message: "Invoice created successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Add Offer Endpoint
      case "addNewOffer": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addOffer." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          let { type, number, date, discount_terms, expiry_date, due_date, status, tags, items: itemsRaw, grand_total, memo } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesOffers/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!type || !date || !expiry_date || !due_date || !status || !items || items.length === 0 || !grand_total) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          // const requestDate = new Date(date);
          // const month = requestDate.getMonth() + 1; // 0-based
          // const year = requestDate.getFullYear();

          // // Generate prefix for this month: YYYYMM
          // const prefix = `${year}${String(month).padStart(2, "0")}`;

          // // Fetch latest offer number
          // const { data: latestOffer, error: fetchError } = await supabase
          //   .from("offers")
          //   .select("number")
          //   .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          //   .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          //   .order("number", { ascending: false })
          //   .limit(1);

          // if (fetchError) {
          //   return res.status(500).json({ error: true, message: "Failed to fetch latest offer number: " + fetchError.message });
          // }

          // // Determine the next counter based on latest request
          // let counter = 1;
          // if (latestOffer && latestOffer.length > 0) {
          //   const lastNumber = latestOffer[0].number.toString();
          //   const lastCounter = parseInt(lastNumber.slice(6), 10);
          //   counter = lastCounter + 1;
          // }

          // // Combine prefix + counter
          // const nextNumber = parseInt(`${prefix}${counter}`, 10);

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("offers").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch offer numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The offer number "${inputNumber}" has already been used. Please enter a new and unique offer number that has not been used before.`,
            });
          }

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          // Final grand total
          // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          const { error } = await supabase.from("offers").insert([
            {
              user_id: user.id,
              type,
              date,
              // number: nextNumber,
              number,
              discount_terms,
              expiry_date,
              due_date,
              status,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              items: updatedItems,
              grand_total,
              memo,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create offer: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Offer",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({
            error: false,
            message: "Offer created successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Add Order Endpoint
      case "addNewOrder": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addOrder." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          let { type, number, date, orders_date, due_date, status, tags, items: itemsRaw, grand_total, memo } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesOrders/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!type || !date || !orders_date || !due_date || !status || !items || items.length === 0 || !grand_total) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          // const requestDate = new Date(date);
          // const month = requestDate.getMonth() + 1; // 0-based
          // const year = requestDate.getFullYear();

          // // Generate prefix for this month: YYYYMM
          // const prefix = `${year}${String(month).padStart(2, "0")}`;

          // // Fetch latest order number
          // const { data: latestOrder, error: fetchError } = await supabase
          //   .from("orders")
          //   .select("number")
          //   .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          //   .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          //   .order("number", { ascending: false })
          //   .limit(1);

          // if (fetchError) {
          //   return res.status(500).json({ error: true, message: "Failed to fetch latest order number: " + fetchError.message });
          // }

          // // Determine the next counter based on latest request
          // let counter = 1;
          // if (latestOrder && latestOrder.length > 0) {
          //   const lastNumber = latestOrder[0].number.toString();
          //   const lastCounter = parseInt(lastNumber.slice(6), 10);
          //   counter = lastCounter + 1;
          // }
          // // Combine prefix + counter
          // const nextNumber = parseInt(`${prefix}${counter}`, 10);

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("orders").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch order numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The order number "${inputNumber}" has already been used. Please enter a new and unique order number that has not been used before.`,
            });
          }

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          // Final grand total
          // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          const { error } = await supabase.from("orders").insert([
            {
              user_id: user.id,
              type,
              date,
              // number: nextNumber,
              number,
              orders_date,
              due_date,
              status,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              items: updatedItems,
              grand_total,
              memo,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create order: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Order",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({
            error: false,
            message: "Order created successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Add Request Endpoint
      case "addNewRequest": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addRequest." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          let {
            type,
            date,
            number,
            requested_by,
            urgency,
            due_date,
            status,
            tags,
            items: itemsRaw,
            grand_total,
            memo,
            vendor_name,
            vendor_address,
            vendor_phone,
            installment_amount,
            tax_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            dpp,
            ppn,
            pph,
            total,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesRequests/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (
            !type ||
            !date ||
            !number ||
            !requested_by ||
            !urgency ||
            !due_date ||
            !status ||
            !items ||
            items.length === 0 ||
            !grand_total ||
            !vendor_name ||
            !vendor_address ||
            !vendor_phone ||
            !tax_method ||
            !ppn_percentage ||
            !pph_type ||
            !pph_percentage ||
            !dpp ||
            !ppn ||
            !pph ||
            !total
          ) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          if (installment_amount) {
            const minDp = 0.1 * grand_total; // 10% from grand_total

            if (Number(installment_amount) < minDp) {
              return res.status(400).json({
                error: true,
                message: `The down payment amount entered is too low. It must be at least 10% of the total invoice amount = (${minDp.toLocaleString("id-ID")}).`,
              });
            }
          }

          // const requestDate = new Date(date);
          // const month = requestDate.getMonth() + 1; // 0-based
          // const year = requestDate.getFullYear();

          // // Generate prefix for this month: YYYYMM
          // const prefix = `${year}${String(month).padStart(2, "0")}`;

          // // Fetch latest request number for the same prefix
          // const { data: latestRequests, error: fetchError } = await supabase
          //   .from("requests")
          //   .select("number")
          //   .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          //   .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          //   .order("number", { ascending: false })
          //   .limit(1);

          // if (fetchError) {
          //   return res.status(500).json({ error: true, message: "Failed to fetch latest request number: " + fetchError.message });
          // }

          // // Determine the next counter based on latest request
          // let counter = 1;
          // if (latestRequests && latestRequests.length > 0) {
          //   const lastNumber = latestRequests[0].number.toString();
          //   const lastCounter = parseInt(lastNumber.slice(6), 10);
          //   counter = lastCounter + 1;
          // }

          // // Combine prefix + counter
          // const nextNumber = parseInt(`${prefix}${counter}`, 10);

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("requests").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch request numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The request number "${inputNumber}" has already been used. Please enter a new and unique request number that has not been used before.`,
            });
          }

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          // Final grand total
          // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          const { error } = await supabase.from("requests").insert([
            {
              user_id: user.id,
              type,
              date,
              number,
              requested_by,
              urgency,
              due_date,
              status,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              items: updatedItems,
              grand_total,
              memo,
              vendor_name,
              vendor_address,
              vendor_phone,
              installment_amount: Math.round(installment_amount),
              tax_method,
              ppn_percentage,
              pph_type,
              pph_percentage,
              dpp,
              ppn,
              pph,
              total,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create request: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Request",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({
            error: false,
            message: "Request created successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      //   Add Shipment Endpoint
      case "addNewShipment": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addShipment." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          let {
            type,
            date,
            number,
            tracking_number,
            carrier,
            shipping_date,
            due_date,
            status,
            tags,
            items: itemsRaw,
            grand_total,
            memo,
            vendor_name,
            vendor_address,
            vendor_phone,
            tax_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            dpp,
            ppn,
            pph,
            total,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesShipments/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (
            !type ||
            !date ||
            !number ||
            !tracking_number ||
            !carrier ||
            !shipping_date ||
            !due_date ||
            !status ||
            !items ||
            items.length === 0 ||
            !grand_total ||
            !vendor_name ||
            !vendor_address ||
            !vendor_phone ||
            !tax_method ||
            !ppn_percentage ||
            !pph_type ||
            !pph_percentage ||
            !dpp ||
            !ppn ||
            !pph ||
            !total
          ) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          // const requestDate = new Date(date);
          // const month = requestDate.getMonth() + 1; // 0-based
          // const year = requestDate.getFullYear();

          // // Generate prefix for this month: YYYYMM
          // const prefix = `${year}${String(month).padStart(2, "0")}`;

          // // Fetch latest shipment number
          // const { data: latestShipment, error: fetchError } = await supabase
          //   .from("shipments")
          //   .select("number")
          //   .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          //   .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          //   .order("number", { ascending: false })
          //   .limit(1);

          // if (fetchError) {
          //   return res.status(500).json({ error: true, message: "Failed to fetch latest shipment number: " + fetchError.message });
          // }

          // // Determine the next counter based on latest request
          // let counter = 1;
          // if (latestShipment && latestShipment.length > 0) {
          //   const lastNumber = latestShipment[0].number.toString();
          //   const lastCounter = parseInt(lastNumber.slice(6), 10);
          //   counter = lastCounter + 1;
          // }

          // // Combine prefix + counter
          // const nextNumber = parseInt(`${prefix}${counter}`, 10);

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("shipments").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch shipment numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The shipment number "${inputNumber}" has already been used. Please enter a new and unique shipment number that has not been used before.`,
            });
          }

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          // Final grand total
          // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          const { error } = await supabase.from("shipments").insert([
            {
              user_id: user.id,
              type,
              date,
              number,
              tracking_number,
              carrier,
              shipping_date,
              due_date,
              status,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              items: updatedItems,
              grand_total,
              memo,
              vendor_name,
              vendor_address,
              vendor_phone,
              tax_method,
              ppn_percentage,
              pph_type,
              pph_percentage,
              dpp,
              ppn,
              pph,
              total,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create shipment: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Shipment",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({
            error: false,
            message: "Shipment created successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Add Quotation Endpoint
      case "addNewQuotation": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addNewQuotation." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          let {
            number,
            vendor_name,
            quotation_date,
            valid_until,
            status,
            terms,
            items: itemsRaw,
            total,
            memo,
            type,
            due_date,
            tags,
            grand_total,
            tax_method,
            dpp,
            ppn,
            pph,
            vendor_address,
            vendor_phone,
            start_date,
            ppn_percentage,
            pph_percentage,
            pph_type,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          const attachmentFiles = req.files?.attachment_url;
          let attachment_urls = [];

          if (attachmentFiles && attachmentFiles.length > 0) {
            const fs = require("fs/promises");
            const path = require("path");

            for (const file of attachmentFiles) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || "");
                const allowedExt = [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"];

                if (!allowedExt.includes(fileExt.toLowerCase())) {
                  return res.status(400).json({ error: true, message: "File type not allowed" });
                }

                const fileName = `purchasesQuotations/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Failed to upload attachment: " + uploadError.message });
                }

                attachment_urls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (
            !number ||
            !vendor_name ||
            !quotation_date ||
            !valid_until ||
            !status ||
            !terms ||
            !items ||
            items.length === 0 ||
            !total ||
            !type ||
            !due_date ||
            !grand_total ||
            !tax_method ||
            !dpp ||
            !ppn ||
            !pph ||
            !vendor_address ||
            !vendor_phone ||
            !start_date ||
            !ppn_percentage ||
            !pph_percentage ||
            !pph_type
          ) {
            return res.status(400).json({ error: true, message: "Missing required fields" });
          }

          // // Generate quotation number
          // const quoteDate = new Date(quotation_date);
          // const month = quoteDate.getMonth() + 1;
          // const year = quoteDate.getFullYear();
          // const prefix = `${year}${String(month).padStart(2, "0")}`;

          // const { data: latestQuote, error: fetchError } = await supabase
          //   .from("quotations_purchases")
          //   .select("number")
          //   .gte("quotation_date", `${year}-${String(month).padStart(2, "0")}-01`)
          //   .lt("quotation_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          //   .order("number", { ascending: false })
          //   .limit(1);

          // if (fetchError) {
          //   return res.status(500).json({
          //     error: true,
          //     message: "Failed to fetch latest quotation number: " + fetchError.message,
          //   });
          // }

          // let counter = 1;
          // if (latestQuote && latestQuote.length > 0) {
          //   const lastNumber = latestQuote[0].number.toString();
          //   const lastCounter = parseInt(lastNumber.slice(6), 10);
          //   counter = lastCounter + 1;
          // }

          // const nextQuotationNumber = parseInt(`${prefix}${counter}`, 10);

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("quotations_purchases").select("number");

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch quotation numbers: " + fetchError.message,
            });
          }

          // Assume user input is sent via req.body.number
          const inputNumber = req.body.number;

          // Check if the number already exists
          const numberExists = allNumbers.some((row) => row.number === inputNumber);

          if (numberExists) {
            return res.status(400).json({
              error: true,
              message: `The quotation number "${inputNumber}" has already been used. Please enter a new and unique quotation number that has not been used before.`,
            });
          }

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          const { error: insertError } = await supabase.from("quotations_purchases").insert([
            {
              user_id: user.id,
              number,
              vendor_name,
              quotation_date,
              valid_until,
              status,
              terms,
              items: updatedItems,
              total,
              memo,
              type,
              due_date,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              grand_total,
              tax_method,
              dpp,
              ppn,
              pph,
              vendor_address,
              vendor_phone,
              start_date,
              ppn_percentage,
              pph_percentage,
              pph_type,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (insertError)
            return res.status(500).json({
              error: true,
              message: "Failed to create quotation: " + insertError.message,
            });

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Quotation",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(201).json({ error: false, message: "Quotation created successfully" });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Billing Order Endpoint
      case "editNewBillingOrder": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editNewBillingOrder." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["finance", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const { id, vendor_name, order_date, number, type, dpp, ppn, ppn_percentage, paid_amount, memo, items: itemsRaw, installment_amount, installment_COA, payment_COA, installment_name, payment_name, status, filesToDelete } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesBillingOrders/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Billing ID is required",
            });
          }

          // Check if billing exists and belongs to user
          const { data: existingBilling, error: fetchError } = await supabase.from("billing_order").select("*").eq("id", id).single();

          if (fetchError || !existingBilling) {
            return res.status(404).json({
              error: true,
              message: "Billing not found or unauthorized",
            });
          }

          // Prepare update data
          const updateData = {
            user_id: user.id,
            memo,
            installment_COA,
            installment_amount,
            payment_COA,
            installment_name,
            payment_name,
            status,
            dpp,
            ppn,
            ppn_percentage,
            paid_amount,
            attachment_url: newAttachmentUrls || null,
            updated_at: new Date().toISOString(),
          };

          // Update billing
          const { error: updateError } = await supabase.from("billing_order").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update billing: " + updateError.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Billing Order",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({
            error: false,
            message: "Billing order updated successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Billing Invoice Endpoint
      case "editNewBillingInvoice": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editNewBillingInvoice." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["finance", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const { id, payment_method, payment_COA, vendor_COA, memo, installment_type, paid_amount, payment_name, filesToDelete } = req.body;

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesBillingInvoices/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Billing ID is required",
            });
          }

          // Check if billing exists and belongs to user
          const { data: existingBilling, error: fetchError } = await supabase.from("billing_invoice").select("*").eq("id", id).single();

          if (fetchError || !existingBilling) {
            return res.status(404).json({
              error: true,
              message: "Billing not found or unauthorized",
            });
          }

          // let installmentAmount;
          // try {
          //   if (typeof req.body.installment_amount === "string" && req.body.installment_amount.trim() !== "") {
          //     installmentAmount = JSON.parse(req.body.installment_amount);
          //   } else {
          //     installmentAmount = req.body.installment_amount;
          //   }
          // } catch (parseError) {
          //   return res.status(400).json({
          //     error: true,
          //     message: "Invalid installment_amount format. Must be valid JSON array: " + parseError.message,
          //   });
          // }

          // Prepare update data
          const updateData = {
            user_id: user.id,
            payment_method,
            payment_COA,
            vendor_COA,
            memo,
            installment_type,
            paid_amount,
            payment_name,
            attachment_url: newAttachmentUrls || null,
            updated_at: new Date().toISOString(),
          };

          // Update billing
          const { error: updateError } = await supabase.from("billing_invoice").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update billing: " + updateError.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Billing Invoice",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({
            error: false,
            message: "Billing updated successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Invoice Endpoint
      case "editNewInvoice": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editInvoice." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["finance", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const {
            id,
            type,
            date,
            number,
            approver,
            due_date,
            status,
            items: itemsRaw,
            tax_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            dpp,
            ppn,
            pph,
            grand_total,
            tags,
            memo,
            vendor_name,
            vendor_address,
            vendor_phone,
            terms,
            freight_in,
            insurance,
            vendor_COA,
            total,
            filesToDelete,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesInvoices/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Invoice ID is required",
            });
          }

          // Check if invoice exists and belongs to user
          const { data: existingInvoice, error: fetchError } = await supabase.from("invoices").select("*").eq("id", id).single();

          if (fetchError || !existingInvoice) {
            return res.status(404).json({
              error: true,
              message: "Invoice not found or unauthorized",
            });
          }

          if (existingInvoice && existingInvoice.status === "Completed") {
            const { data: billingInvoices, error: billingError } = await supabase.from("billing_invoice").select("id, number, status").eq("number", existingInvoice.number);

            console.log("Fetched billing invoices:", billingInvoices, "Billing error:", billingError);

            if (billingError) {
              return res.status(500).json({
                error: true,
                message: "Failed to check billing_order: " + billingError.message,
              });
            }

            if (billingInvoices[0].status === "Completed" || billingInvoices[0].status === "Pending") {
              return res.status(200).json({
                error: true,
                message: "Billing Invoice is already Completed/Already Paid in Installment",
              });
            }

            if (billingInvoices && billingInvoices.length > 0 && billingInvoices[0].status === "Unpaid") {
              const invoiceNumber = `INV-${existingInvoice.number}`;

              console.log("Deleting journal entries for invoice number:", invoiceNumber);

              const { error: deleteJournalError } = await supabase.from("journal_entries").delete().eq("transaction_number", invoiceNumber);

              if (deleteJournalError) {
                return res.status(500).json({ error: true, message: "Failed to delete related journal: " + deleteJournalError.message });
              }

              const { error: deleteError } = await supabase.from("billing_invoice").delete().eq("number", existingInvoice.number);

              if (deleteError) {
                return res.status(500).json({ error: true, message: "Failed to delete related data: " + deleteError.message });
              }

              const { error: resetError } = await supabase.from("invoices").update({ status: "Pending", updated_at: new Date().toISOString() }).eq("id", id);

              if (resetError) {
                return res.status(500).json({ error: true, message: "Failed to reset invoice status: " + resetError.message });
              }
            }
          }

          // Update items with total_per_item if items are provided
          let updatedItems = existingInvoice.items;
          if (items && items.length > 0) {
            updatedItems = items.map((item) => {
              const qty = Number(item.qty) || 0;
              const price = Number(item.price) || 0;
              const total_per_item = qty * price;

              return {
                ...item,
                total_per_item,
              };
            });
          }

          // Calculate totals
          // const dpp = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);
          // const ppn = (dpp * (ppn_percentage || existingInvoice.ppn_percentage || 0)) / 100;
          // const pph = (dpp * (pph_percentage || existingInvoice.pph_percentage || 0)) / 100;
          // const grand_total = dpp + ppn - pph;

          // Prepare update data
          const updateData = {
            user_id: user.id,
            type: type,
            date: date,
            number: number,
            approver: approver,
            due_date: due_date,
            status: status,
            items: updatedItems,
            tax_method: tax_method,
            ppn_percentage: ppn_percentage,
            pph_type: pph_type,
            pph_percentage: pph_percentage,
            dpp: dpp,
            ppn: ppn,
            pph: pph,
            grand_total: grand_total,
            tags: tags,
            memo: memo,
            vendor_name: vendor_name,
            vendor_address: vendor_address,
            vendor_phone: vendor_phone,
            terms: terms,
            freight_in: freight_in,
            insurance: insurance,
            vendor_COA: vendor_COA,
            total: total,
            updated_at: new Date().toISOString(),
          };

          // Update invoice
          const { error: updateError } = await supabase.from("invoices").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update invoice: " + updateError.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Invoice",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({
            error: false,
            message: "Invoice updated successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Offer Endpoint
      case "editNewOffer": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editOffer." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const { id, type, date, discount_terms, expiry_date, due_date, status, tags, items: itemsRaw, memo, filesToDelete } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesOffers/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Offer ID is required",
            });
          }

          // Check if offer exists and belongs to user
          const { data: existingOffer, error: fetchError } = await supabase.from("offers").select("*").eq("id", id).single();

          if (fetchError || !existingOffer) {
            return res.status(404).json({
              error: true,
              message: "Offer not found or unauthorized",
            });
          }

          // Update items with total_per_item if items are provided
          let updatedItems = existingOffer.items;
          if (items && items.length > 0) {
            updatedItems = items.map((item) => {
              const qty = Number(item.qty) || 0;
              const price = Number(item.price) || 0;
              const total_per_item = qty * price;

              return {
                qty,
                price,
                item_name: item.name || item.item_name,
                total_per_item,
              };
            });
          }

          // Calculate grand total
          const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          // First, let's verify the update conditions
          const { data: verifyData, error: verifyError } = await supabase.from("offers").select("id").eq("id", id);

          if (verifyError) {
            return res.status(500).json({
              error: true,
              message: "Error verifying offer: " + verifyError.message,
            });
          }

          if (!verifyData || verifyData.length === 0) {
            return res.status(404).json({
              error: true,
              message: "Offer not found or unauthorized",
            });
          }

          // Prepare the update data
          const updateData = {
            user_id: user.id,
            type: type || existingOffer.type,
            date: date || existingOffer.date,
            discount_terms: discount_terms !== undefined ? discount_terms : existingOffer.discount_terms,
            expiry_date: expiry_date !== undefined ? expiry_date : existingOffer.expiry_date,
            due_date: due_date || existingOffer.due_date,
            status: status || existingOffer.status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingOffer.tags,
            items: updatedItems,
            grand_total,
            memo,
            attachment_url: newAttachmentUrls || null,
            updated_at: new Date().toISOString(),
          };

          // Update offer
          const { error: updateError } = await supabase.from("offers").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update offer: " + updateError.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Offer",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({
            error: false,
            message: "Offer updated successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Order Endpoint
      case "editNewOrder": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editOrder." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const { id, type, date, orders_date, due_date, status, tags, items: itemsRaw, memo, filesToDelete } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesOrders/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Order ID is required",
            });
          }

          // Check if order exists and belongs to user
          const { data: existingOrder, error: fetchError } = await supabase.from("orders").select("*").eq("id", id).single();

          if (fetchError || !existingOrder) {
            return res.status(404).json({
              error: true,
              message: "Order not found or unauthorized",
            });
          }

          // Update items with total_per_item if items are provided
          let updatedItems = existingOrder.items;
          if (items && items.length > 0) {
            updatedItems = items.map((item) => {
              const qty = Number(item.qty) || 0;
              const price = Number(item.price) || 0;
              const total_per_item = qty * price;

              return {
                ...item,
                total_per_item,
              };
            });
          }

          // Calculate grand total
          const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          // Prepare update data
          const updateData = {
            user_id: user.id,
            type: type || existingOrder.type,
            date: date || existingOrder.date,
            orders_date: orders_date || existingOrder.orders_date,
            due_date: due_date || existingOrder.due_date,
            status: status || existingOrder.status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingOrder.tags,
            items: updatedItems,
            grand_total,
            memo,
            attachment_url: newAttachmentUrls || null,
            updated_at: new Date().toISOString(),
          };

          // Update order
          const { error: updateError } = await supabase.from("orders").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update order: " + updateError.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Order",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({
            error: false,
            message: "Order updated successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Request Endpoint
      case "editNewRequest": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editRequest." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const {
            id,
            filesToDelete,
            type,
            date,
            number,
            requested_by,
            urgency,
            due_date,
            status,
            tags,
            items: itemsRaw,
            grand_total,
            memo,
            vendor_name,
            vendor_address,
            vendor_phone,
            installment_amount,
            tax_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            dpp,
            ppn,
            pph,
            total,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesRequests/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Request ID is required",
            });
          }

          if (installment_amount) {
            const minDp = 0.1 * grand_total; // 10% from grand_total

            if (Number(installment_amount) < minDp) {
              return res.status(400).json({
                error: true,
                message: `The down payment amount entered is too low. It must be at least 10% of the total invoice amount = (${minDp.toLocaleString("id-ID")}).`,
              });
            }
          }

          // Check if request exists and belongs to user
          const { data: existingRequest, error: fetchError } = await supabase.from("requests").select("*").eq("id", id).single();

          if (fetchError || !existingRequest) {
            return res.status(404).json({
              error: true,
              message: "Request not found or unauthorized",
            });
          }

          if (existingRequest && existingRequest.status === "Completed") {
            const { data: billingOrders, error: billingError } = await supabase.from("billing_order").select("number, status").eq("number", existingRequest.number);

            if (billingError) {
              return res.status(500).json({
                error: true,
                message: "Failed to check billing_order: " + billingError.message,
              });
            }

            if (billingOrders[0].status === "Completed") {
              return res.status(200).json({
                error: true,
                message: "Billing Order is already Completed",
              });
            }

            if (billingOrders && billingOrders.length > 0 && billingOrders[0].status !== "Completed") {
              const billingOrderNumber = `ORD-${existingRequest.number}`;
              const { error: deleteError } = await supabase.from("billing_order").delete().eq("number", billingOrderNumber);

              if (deleteError) {
                return res.status(500).json({
                  error: true,
                  message: "Failed to delete related billing_order: " + deleteError.message,
                });
              }
            }

            const { error: deleteOrderError } = await supabase.from("orders").delete().eq("number", existingRequest.number);

            if (deleteOrderError) {
              return res.status(500).json({ error: true, message: "Failed to delete related order: " + deleteOrderError.message });
            }

            const { error: resetError } = await supabase.from("requests").update({ status: "Pending", updated_at: new Date().toISOString() }).eq("id", id);

            if (resetError) {
              return res.status(500).json({ error: true, message: "Failed to reset request status: " + resetError.message });
            }
          }

          // Update items with total_per_item if items are provided
          let updatedItems = existingRequest.items;
          if (items && items.length > 0) {
            updatedItems = items.map((item) => {
              const qty = Number(item.qty) || 0;
              const price = Number(item.price) || 0;
              const total_per_item = qty * price;

              return {
                ...item,
                total_per_item,
              };
            });
          }

          // Calculate grand total
          // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          // Prepare update data
          const updateData = {
            user_id: user.id,
            type: type,
            date: date,
            number: number,
            requested_by: requested_by,
            urgency: urgency,
            due_date: due_date,
            status: status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingRequest.tags,
            items: updatedItems,
            grand_total,
            memo,
            vendor_name: vendor_name,
            vendor_address: vendor_address,
            vendor_phone: vendor_phone,
            installment_amount: installment_amount,
            tax_method: tax_method,
            ppn_percentage: ppn_percentage,
            pph_type: pph_type,
            pph_percentage: pph_percentage,
            dpp: dpp,
            ppn: ppn,
            pph: pph,
            total: total,
            attachment_url: newAttachmentUrls || null,
            updated_at: new Date().toISOString(),
          };

          // Update request
          const { error: updateError } = await supabase.from("requests").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update request: " + updateError.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Request",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({
            error: false,
            message: "Request updated successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Shipment Endpoint
      case "editNewShipment": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editShipment." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const {
            id,
            type,
            date,
            number,
            tracking_number,
            carrier,
            shipping_date,
            due_date,
            status,
            tags,
            items: itemsRaw,
            grand_total,
            memo,
            vendor_name,
            vendor_address,
            vendor_phone,
            tax_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            dpp,
            ppn,
            pph,
            total,
            filesToDelete,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesShipments/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({
              error: true,
              message: "Shipment ID is required",
            });
          }

          // Check if shipment exists and belongs to user
          const { data: existingShipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", id).single();

          if (fetchError || !existingShipment) {
            return res.status(404).json({
              error: true,
              message: "Shipment not found or unauthorized",
            });
          }

          // Update items with total_per_item if items are provided
          let updatedItems = existingShipment.items;
          if (items && items.length > 0) {
            updatedItems = items.map((item) => {
              const qty = Number(item.qty) || 0;
              const price = Number(item.price) || 0;
              const total_per_item = qty * price;

              return {
                ...item,
                total_per_item,
              };
            });
          }

          // Calculate grand total
          // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          // Prepare update data
          const updateData = {
            user_id: user.id,
            type: type,
            date: date,
            number: number,
            tracking_number: tracking_number,
            carrier: carrier,
            shipping_date: shipping_date,
            due_date: due_date,
            status: status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingShipment.tags,
            items: updatedItems,
            grand_total: grand_total,
            memo: memo,
            vendor_name: vendor_name,
            vendor_address: vendor_address,
            vendor_phone: vendor_phone,
            tax_method: tax_method,
            ppn_percentage: ppn_percentage,
            pph_type: pph_type,
            pph_percentage: pph_percentage,
            dpp: dpp,
            ppn: ppn,
            pph: pph,
            total: total,
            attachment_url: newAttachmentUrls || null,
            updated_at: new Date().toISOString(),
          };

          // Update shipment
          const { error: updateError } = await supabase.from("shipments").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update shipment: " + updateError.message,
            });
          }

          if (existingShipment && (existingShipment.status === "Completed" || existingShipment.status === "Received")) {
            const { error: resetError } = await supabase.from("shipments").update({ status: "Pending", updated_at: new Date().toISOString() }).eq("id", id);

            if (resetError) {
              return res.status(500).json({ error: true, message: "Failed to reset shipment status: " + resetError.message });
            }
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Shipment",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({
            error: false,
            message: "Shipment updated successfully",
          });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Quotations Endpoint
      case "editNewQuotation": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editQuotation." });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["purchasing", "admin"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        try {
          const {
            id,
            filesToDelete,
            number,
            vendor_name,
            quotation_date,
            valid_until,
            status,
            terms,
            items: itemsRaw,
            total,
            memo,
            type,
            due_date,
            tags,
            grand_total,
            tax_method,
            dpp,
            ppn,
            pph,
            vendor_address,
            vendor_phone,
            start_date,
            ppn_percentage,
            pph_percentage,
            pph_type,
          } = req.body;

          // Parse items if they come in string form (because of form-data)
          let items;
          try {
            if (typeof itemsRaw === "string") {
              items = JSON.parse(itemsRaw);
            } else {
              items = itemsRaw;
            }
          } catch (parseError) {
            return res.status(400).json({
              error: true,
              message: "Invalid items format. Must be valid JSON array: " + parseError.message,
            });
          }

          // Parse filesToDelete (string JSON -> array)
          let filesToDeleteArr = [];
          if (filesToDelete) {
            try {
              filesToDeleteArr = JSON.parse(filesToDelete);
            } catch (err) {
              return res.status(400).json({ error: true, message: "Invalid filesToDelete JSON: " + err.message });
            }
          }

          // Delete files from Supabase Storage
          if (filesToDeleteArr.length > 0) {
            const { error: deleteError } = await supabase.storage.from("private").remove(filesToDeleteArr);

            if (deleteError) {
              return res.status(500).json({
                error: true,
                message: "Failed to delete files: " + deleteError.message,
              });
            }
          }

          // Handle file upload
          const attachmentFileArray = req.files?.attachment_url;
          let newAttachmentUrls = [];

          if (attachmentFileArray) {
            const fs = require("fs/promises");
            const path = require("path");

            const files = Array.isArray(attachmentFileArray) ? attachmentFileArray : [attachmentFileArray];

            for (const file of files) {
              if (!file || !file.filepath) {
                return res.status(400).json({ error: true, message: "Invalid file uploaded" });
              }

              try {
                const filePath = file.filepath;
                const fileBuffer = await fs.readFile(filePath);

                const fileExt = path.extname(file.originalFilename || ".dat");
                const fileName = `purchasesQuotations/${user.id}_${Date.now()}_${file.originalFilename}`;

                const { data: uploadData, error: uploadError } = await supabase.storage.from("private").upload(fileName, fileBuffer, {
                  contentType: file.mimetype || "application/octet-stream",
                  upsert: false,
                });

                if (uploadError) {
                  return res.status(500).json({ error: true, message: "Upload failed: " + uploadError.message });
                }

                newAttachmentUrls.push(uploadData.path);
              } catch (err) {
                return res.status(500).json({ error: true, message: "Failed to process file: " + err.message });
              }
            }
          }

          if (!id) {
            return res.status(400).json({ error: true, message: "Missing required fields" });
          }

          const { data: quotationData, error: quotationError } = await supabase.from("quotations_purchases").select("status, number").eq("id", id).single();

          if (quotationError) {
            return res.status(500).json({ error: true, message: "Failed to fetch quotation: " + quotationError.message });
          }

          if (quotationData && quotationData.status === "Completed") {
            const { error: deleteOfferError } = await supabase.from("offers").delete().eq("number", quotationData.number);

            if (deleteOfferError) {
              return res.status(500).json({ error: true, message: "Failed to delete related offer: " + deleteOfferError.message });
            }

            const { error: resetError } = await supabase.from("quotations_purchases").update({ status: "Pending", updated_at: new Date().toISOString() }).eq("id", id);

            if (resetError) {
              return res.status(500).json({ error: true, message: "Failed to reset quotation status: " + resetError.message });
            }
          }

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          const { error: updateError } = await supabase
            .from("quotations_purchases")
            .update({
              number,
              vendor_name,
              quotation_date,
              valid_until,
              status,
              terms,
              items: updatedItems,
              total,
              memo,
              type,
              due_date,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              grand_total,
              tax_method,
              dpp,
              ppn,
              pph,
              vendor_address,
              vendor_phone,
              start_date,
              ppn_percentage,
              pph_percentage,
              pph_type,
              attachment_url: newAttachmentUrls || null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id);

          if (updateError) {
            return res.status(500).json({ error: true, message: "Failed to update quotation: " + updateError.message });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Edit Quotation",
              http_method: req.method,
              updated_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }

          return res.status(200).json({ error: false, message: "Quotation updated successfully" });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Delete Billing Summary, Invoice, Shipment, Order, Offer, and Request Endpoint
      case "deleteBillingOrder":
      case "deleteBillingInvoice":
      case "deleteInvoice":
      case "deleteShipment":
      case "deleteOrder":
      case "deleteOffer":
      case "deleteRequest":
      case "deleteQuotation": {
        if (req.method !== "DELETE") {
          return res.status(405).json({
            error: true,
            message: `Method not allowed. Use DELETE for ${action}.`,
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({
            error: true,
            message: "No authorization header provided",
          });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          return res.status(401).json({
            error: true,
            message: "Invalid or expired token",
          });
        }

        // // Role permissions per case
        // const permissionsMap = {
        //   deleteInvoice: ["accounting", "finance", "manager", "admin"],
        //   deleteShipment: ["warehousing", "logistics", "manager", "admin"],
        //   deleteOrder: ["procurement", "manager", "admin"],
        //   deleteOffer: ["procurement", "manager", "admin"],
        //   deleteRequest: ["procurement", "manager", "admin"],
        // };

        // // Get user role from database
        // const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        // if (profileError || !userProfile) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Unable to fetch user role or user not found",
        //   });
        // }

        // // Determine current case
        // const currentCase = action;

        // // Get allowed roles for current action
        // const allowedRoles = permissionsMap[currentCase] || [];

        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: `Access denied. Your role (${userProfile.role}) is not authorized to perform ${currentCase}.`,
        //   });
        // }

        const tableMap = {
          deleteBillingOrder: "billing_order",
          deleteBillingInvoice: "billing_invoice",
          deleteInvoice: "invoices",
          deleteShipment: "shipments",
          deleteOrder: "orders",
          deleteOffer: "offers",
          deleteRequest: "requests",
          deleteQuotation: "quotations_purchases",
        };

        const table = tableMap[action];
        const { id } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: "ID is required",
          });
        }

        const { data: item, error: fetchError } = await supabase.from(table).select("id, status, number").eq("id", id).single();

        console.log("Fetched item:", item, "Fetch error:", fetchError);

        if (fetchError || !item || item.length === 0) {
          return res.status(404).json({
            error: true,
            message: `${action.replace("delete", "")} not found or unauthorized`,
          });
        }

        if (action === "deleteQuotation") {
          if (item && item.status === "Completed") {
            const { error: deleteError } = await supabase.from("offers").delete().eq("number", item.number);

            if (deleteError) {
              return res.status(500).json({ error: true, message: "Failed to delete related data: " + deleteError.message });
            }
          }
        } else if (action === "deleteRequest") {
          if (item && item.status === "Completed") {
            const { error: deleteError } = await supabase.from("orders").delete().eq("number", item.number);

            if (deleteError) {
              return res.status(500).json({ error: true, message: "Failed to delete related data: " + deleteError.message });
            }

            const { data: billingOrders, error: billingError } = await supabase.from("billing_order").select("id, number, status").eq("number", item.number);

            console.log("Fetched billing orders:", billingOrders, "Billing error:", billingError);

            if (billingError) {
              return res.status(500).json({
                error: true,
                message: "Failed to check billing_order: " + billingError.message,
              });
            }

            if (billingOrders[0].status === "Completed") {
              return res.status(200).json({
                error: true,
                message: "Billing Order is already Completed",
              });
            }

            if (billingOrders && billingOrders.length > 0 && billingOrders[0].status !== "Completed") {
              const billingOrderNumber = `ORD-${item.number}`;

              const { error: deleteError } = await supabase.from("billing_order").delete().eq("number", billingOrderNumber);

              if (deleteError) {
                return res.status(500).json({
                  error: true,
                  message: "Failed to delete related billing_order: " + deleteError.message,
                });
              }
            }
          }
        } else if (action === "deleteInvoice") {
          if (item && item.status === "Completed") {
            const { data: billingInvoices, error: billingError } = await supabase.from("billing_invoice").select("id, number, status").eq("number", item.number);

            console.log("Fetched billing invoices:", billingInvoices, "Billing error:", billingError);

            if (billingError) {
              return res.status(500).json({
                error: true,
                message: "Failed to check billing_order: " + billingError.message,
              });
            }

            if (billingInvoices[0].status === "Completed" || billingInvoices[0].status === "Pending") {
              return res.status(200).json({
                error: true,
                message: "Billing Invoice is already Completed/Already Paid in Installment",
              });
            }

            if (billingInvoices && billingInvoices.length > 0 && billingInvoices[0].status === "Unpaid") {
              const invoiceNumber = `INV-${item.number}`;

              const { error: deleteError } = await supabase.from("billing_invoice").delete().eq("number", item.number);

              if (deleteError) {
                return res.status(500).json({ error: true, message: "Failed to delete related data: " + deleteError.message });
              }

              const { error: deleteJournalError } = await supabase.from("journal_entries").delete().eq("transaction_number", invoiceNumber);

              if (deleteJournalError) {
                return res.status(500).json({ error: true, message: "Failed to delete related journal: " + deleteJournalError.message });
              }
            }
          }
        }

        const { error: deleteError } = await supabase.from(table).delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({
            error: true,
            message: `Failed to delete data: ${deleteError.message}`,
          });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: `${action}`,
            http_method: req.method,
            deleted_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(200).json({
          error: false,
          message: `${action} deleted successfully`,
        });
      }

      // Get Billing Order Endpoint
      case "getBillingOrder": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
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
        // const allowedRoles = ["accounting", "finance", "manager", "admin"];
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

        let query = supabase.from("billing_order").select("*").order("order_date", { ascending: false }).range(from, to);

        if (search) {
          const stringColumns = ["vendor_name"];
          const numericColumns = ["installment_amount"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqIntConditions = [];
            const eqFloatConditions = [];

            if (!isNaN(search) && Number.isInteger(Number(search))) {
              eqIntConditions.push("number.eq." + Number(search));
            }

            if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
              const value = parseFloat(search);
              eqFloatConditions.push(...numericColumns.map((col) => `${col}.eq.${value}`));
            }

            const codeMatch = search.match(/^BIL-?0*(\d{5,})$/i);
            if (codeMatch) {
              const extractedNumber = parseInt(codeMatch[1], 10);
              if (!isNaN(extractedNumber)) {
                eqIntConditions.push("number.eq." + extractedNumber);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch billing summary: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Billing Invoice Endpoint
      case "getBillingInvoice": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
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
        // const allowedRoles = ["accounting", "finance", "manager", "admin"];
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

        let query = supabase.from("billing_invoice").select("*").order("invoice_date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["vendor_name"];
          const numericColumns = ["grand_total"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqIntConditions = [];
            const eqFloatConditions = [];

            if (!isNaN(search) && Number.isInteger(Number(search))) {
              eqIntConditions.push("number.eq." + Number(search));
            }

            if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
              const value = parseFloat(search);
              eqFloatConditions.push(...numericColumns.map((col) => `${col}.eq.${value}`));
            }

            const codeMatch = search.match(/^BIL-?0*(\d{5,})$/i);
            if (codeMatch) {
              const extractedNumber = parseInt(codeMatch[1], 10);
              if (!isNaN(extractedNumber)) {
                eqIntConditions.push("number.eq." + extractedNumber);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch billing summary: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Invoice Endpoint
      case "getInvoice": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
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
        // const allowedRoles = ["accounting", "finance", "manager", "admin"];
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

        let query = supabase.from("invoices").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["number", "approver", "status"];
          const numericColumns = ["grand_total"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqIntConditions = [];
            const eqFloatConditions = [];
            const dateConditions = [];

            // grand_total search with locale-aware normalization (e.g., 411.639,88 or 411639,88)
            let normalizedSearch = search.replace(/\./g, "").replace(/,/g, ".");
            if (!isNaN(normalizedSearch) && !Number.isNaN(parseFloat(normalizedSearch))) {
              const value = parseFloat(normalizedSearch);
              eqFloatConditions.push(...numericColumns.map((col) => `${col}.eq.${value}`));
            }

            // Date search for 'date' and 'due_date' via text input
            // Supports: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, partial YYYY-MM or MM-YYYY
            const parseDateSearch = (searchStr) => {
              let dateStr = searchStr.trim();

              // YYYY-MM-DD or YYYY/MM/DD
              if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // DD-MM-YYYY or DD/MM/YYYY
              if (/^\d{1,2}[-\/]\d{1,2}[-\/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-\/]/);
                return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
              }

              // Partial: YYYY-MM or YYYY/MM
              if (/^\d{4}[-\/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // Partial: MM-YYYY or MM/YYYY
              if (/^\d{1,2}[-\/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-\/]/);
                return `${parts[1]}-${parts[0].padStart(2, "0")}`;
              }

              return null;
            };

            const parsedDate = parseDateSearch(search);
            if (parsedDate) {
              const isPartialDate = parsedDate.split("-").length === 2; // YYYY-MM
              if (isPartialDate) {
                dateConditions.push(`date.ilike.${parsedDate}%`);
                dateConditions.push(`due_date.ilike.${parsedDate}%`);
              } else {
                dateConditions.push(`date.eq.${parsedDate}`);
                dateConditions.push(`due_date.eq.${parsedDate}`);
              }
            }

            // Support code like INV-00123 (and INV00123) -> search by numeric part
            const codeMatch = search.match(/^INV-?0*(\d{5,})$/i);
            if (codeMatch) {
              const extractedNumber = parseInt(codeMatch[1], 10);
              if (!isNaN(extractedNumber)) {
                eqIntConditions.push("number.eq." + extractedNumber);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions, ...dateConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Shipment Endpoint
      case "getShipment": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
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
        // const allowedRoles = ["warehousing", "logistics", "manager", "admin"];
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

        let query = supabase.from("shipments").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["tracking_number", "carrier", "status"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqIntConditions = [];
            const eqFloatConditions = [];
            const dateConditions = [];

            // Allow searching numeric shipment number directly
            if (!isNaN(search) && Number.isInteger(Number(search))) {
              eqIntConditions.push("number.eq." + Number(search));
            }

            // Search for grand_total (float)
            // Handle comma as decimal separator (e.g., "411639,88" or "411.639,88")
            let normalizedSearch = search.replace(/\./g, "").replace(/,/g, ".");
            if (!isNaN(normalizedSearch) && !Number.isNaN(parseFloat(normalizedSearch))) {
              eqFloatConditions.push("grand_total.eq." + parseFloat(normalizedSearch));
            }

            // Search for dates (date, shipping_date)
            // Support various date formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, and partial YYYY-MM or MM-YYYY
            const parseDateSearch = (searchStr) => {
              let dateStr = searchStr.trim();

              // YYYY-MM-DD or YYYY/MM/DD
              if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // DD-MM-YYYY or DD/MM/YYYY
              if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
              }

              // Partial date: YYYY-MM or YYYY/MM
              if (/^\d{4}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // Partial date: MM-YYYY or MM/YYYY
              if (/^\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[1]}-${parts[0].padStart(2, "0")}`;
              }

              return null;
            };

            const parsedDate = parseDateSearch(search);
            if (parsedDate) {
              const isPartialDate = parsedDate.split("-").length === 2;

              if (isPartialDate) {
                // For partial dates (YYYY-MM), use ilike to match year-month
                dateConditions.push(`date.ilike.${parsedDate}%`);
                dateConditions.push(`shipping_date.ilike.${parsedDate}%`);
              } else {
                // For full dates, use exact match
                dateConditions.push(`date.eq.${parsedDate}`);
                dateConditions.push(`shipping_date.eq.${parsedDate}`);
              }
            }

            // Support code like SH-00123 searching by numeric shipment number
            const codeMatch = search.match(/^SH-?0*(\d{5,})$/i);
            if (codeMatch) {
              const extractedNumber = parseInt(codeMatch[1], 10);
              if (!isNaN(extractedNumber)) {
                eqIntConditions.push("number.eq." + extractedNumber);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions, ...dateConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch shipments: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Order Endpoint
      case "getOrder": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
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

        let query = supabase.from("orders").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["number", "ordered_by", "urgency"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqFloatConditions = [];
            const dateConditions = [];

            // Search for grand_total and installment_amount (float)
            // Handle comma as decimal separator (e.g., "411639,88" or "411.639,88")
            let normalizedSearch = search.replace(/\./g, "").replace(/,/g, ".");
            if (!isNaN(normalizedSearch) && !Number.isNaN(parseFloat(normalizedSearch))) {
              eqFloatConditions.push("grand_total.eq." + parseFloat(normalizedSearch));
              eqFloatConditions.push("installment_amount.eq." + parseFloat(normalizedSearch));
            }

            // Search for dates (date, due_date)
            // Support various date formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, etc.
            const parseDateSearch = (searchStr) => {
              // Try to parse date from various formats
              let dateStr = searchStr.trim();

              // Format: YYYY-MM-DD or YYYY/MM/DD
              if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // Format: DD-MM-YYYY or DD/MM/YYYY
              if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
              }

              // Format: partial date like "2024-01" or "01/2024"
              if (/^\d{4}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              if (/^\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[1]}-${parts[0].padStart(2, "0")}`;
              }

              return null;
            };

            const parsedDate = parseDateSearch(search);
            if (parsedDate) {
              // Check if it's a full date or partial (year-month)
              const isPartialDate = parsedDate.split("-").length === 2;

              if (isPartialDate) {
                // For partial dates (YYYY-MM), use ilike to match year-month
                dateConditions.push(`date.ilike.${parsedDate}%`);
                dateConditions.push(`due_date.ilike.${parsedDate}%`);
              } else {
                // For full dates, use exact match
                dateConditions.push(`date.eq.${parsedDate}`);
                dateConditions.push(`due_date.eq.${parsedDate}`);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqFloatConditions, ...dateConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch orders: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Offer Endpoint
      case "getOffer": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
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

        let query = supabase.from("offers").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["number", "vendor_name", "discount_terms"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqFloatConditions = [];
            const dateConditions = [];

            // Search for grand_total (float)
            // Handle comma as decimal separator (e.g., "411639,88" or "411.639,88")
            let normalizedSearch = search.replace(/\./g, "").replace(/,/g, ".");
            if (!isNaN(normalizedSearch) && !Number.isNaN(parseFloat(normalizedSearch))) {
              eqFloatConditions.push("grand_total.eq." + parseFloat(normalizedSearch));
            }

            // Search for dates (date, start_date, expiry_date)
            // Support various date formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, etc.
            const parseDateSearch = (searchStr) => {
              // Try to parse date from various formats
              let dateStr = searchStr.trim();

              // Format: YYYY-MM-DD or YYYY/MM/DD
              if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // Format: DD-MM-YYYY or DD/MM/YYYY
              if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
              }

              // Format: partial date like "2024-01" or "01/2024"
              if (/^\d{4}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              if (/^\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[1]}-${parts[0].padStart(2, "0")}`;
              }

              return null;
            };

            const parsedDate = parseDateSearch(search);
            if (parsedDate) {
              // Check if it's a full date or partial (year-month)
              const isPartialDate = parsedDate.split("-").length === 2;

              if (isPartialDate) {
                // For partial dates (YYYY-MM), use ilike to match year-month
                dateConditions.push(`date.ilike.${parsedDate}%`);
                dateConditions.push(`start_date.ilike.${parsedDate}%`);
                dateConditions.push(`expiry_date.ilike.${parsedDate}%`);
              } else {
                // For full dates, use exact match
                dateConditions.push(`date.eq.${parsedDate}`);
                dateConditions.push(`start_date.eq.${parsedDate}`);
                dateConditions.push(`expiry_date.eq.${parsedDate}`);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqFloatConditions, ...dateConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch offers: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Request Endpoint
      case "getRequest": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
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

        let query = supabase.from("requests").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["number", "requested_by", "urgency", "status"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqFloatConditions = [];
            const dateConditions = [];

            // Search for grand_total (float)
            // Handle comma as decimal separator (e.g., "411639,88" or "411.639,88")
            let normalizedSearch = search.replace(/\./g, "").replace(/,/g, ".");
            if (!isNaN(normalizedSearch) && !Number.isNaN(parseFloat(normalizedSearch))) {
              eqFloatConditions.push("grand_total.eq." + parseFloat(normalizedSearch));
            }

            // Search for dates (date, due_date)
            // Support various date formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, etc.
            const parseDateSearch = (searchStr) => {
              // Try to parse date from various formats
              let dateStr = searchStr.trim();

              // Format: YYYY-MM-DD or YYYY/MM/DD
              if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // Format: DD-MM-YYYY or DD/MM/YYYY
              if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
              }

              // Format: partial date like "2024-01" or "01/2024"
              if (/^\d{4}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              if (/^\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[1]}-${parts[0].padStart(2, "0")}`;
              }

              return null;
            };

            const parsedDate = parseDateSearch(search);
            if (parsedDate) {
              // Check if it's a full date or partial (year-month)
              const isPartialDate = parsedDate.split("-").length === 2;

              if (isPartialDate) {
                // For partial dates (YYYY-MM), use ilike to match year-month
                dateConditions.push(`date.ilike.${parsedDate}%`);
                dateConditions.push(`due_date.ilike.${parsedDate}%`);
              } else {
                // For full dates, use exact match
                dateConditions.push(`date.eq.${parsedDate}`);
                dateConditions.push(`due_date.eq.${parsedDate}`);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqFloatConditions, ...dateConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch requests: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Approval Billing Invoice Endpoint
      case "getApprovalBillingInvoice": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for Approval Billing.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const limit = parseInt(req.query.limit) || 10;

        let query = supabase.from("billing_invoice").select("*").eq("status", "Pending");
        query = query.order("invoice_date", { ascending: false }).limit(limit);

        const { data, error } = await query;

        if (error) {
          return res.status(500).json({ error: true, message: `Failed to fetch approval data: " + ${error.message}` });
        }

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Approval Invoice Endpoint
      case "getApprovalInvoice": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for Approval Invoice.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const limit = parseInt(req.query.limit) || 10;

        let query = supabase.from("invoices").select("*").eq("status", "Pending");
        query = query.order("date", { ascending: false }).limit(limit);

        const { data, error } = await query;

        if (error) {
          return res.status(500).json({ error: true, message: `Failed to fetch approval data: " + ${error.message}` });
        }

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Approval Shipment Endpoint
      case "getApprovalShipment": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for Approval Shipment.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const limit = parseInt(req.query.limit) || 10;

        let query = supabase.from("shipments").select("*").in("status", ["Pending", "Received"]);
        query = query.order("date", { ascending: false }).limit(limit);

        const { data, error } = await query;

        if (error) {
          return res.status(500).json({ error: true, message: `Failed to fetch approval data: " + ${error.message}` });
        }

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Approval Request Endpoint
      case "getApprovalRequest": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for Approval Request.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const limit = parseInt(req.query.limit) || 10;

        let query = supabase.from("requests").select("*").eq("status", "Pending");
        query = query.order("date", { ascending: false }).limit(limit);

        const { data, error } = await query;

        if (error) {
          return res.status(500).json({ error: true, message: `Failed to fetch approval data: " + ${error.message}` });
        }

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Approval Quotation Endpoint
      case "getApprovalQuotation": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for Approval Quotation.` });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const limit = parseInt(req.query.limit) || 10;

        let query = supabase.from("quotations_purchases").select("*").eq("status", "Pending");
        query = query.order("quotation_date", { ascending: false }).limit(limit);

        const { data, error } = await query;

        if (error) {
          return res.status(500).json({ error: true, message: `Failed to fetch approval data: " + ${error.message}` });
        }

        const formattedData = data.map((item) => ({
          ...item,
          number: `${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Approval Billing Payment Invoices Endpoint (Ibaratnya Tombol Bayar)
      case "sendBillingInvoiceToCOA": {
        if (method !== "POST") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for sendBillingInvoiceToCOA.",
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        // Get user
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        // Get user role
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Billing ID" });
        }
        const billingId = String(id);

        const { data: billing, error: billingError } = await supabase.from("billing_invoice").select("*").eq("id", id).in("status", ["Pending", "pending", "Unpaid", "unpaid"]).single();

        if (billingError || !billing) {
          return res.status(404).json({ error: true, message: "Billing not found or already completed/rejected" });
        }

        let {
          vendor_name,
          terms,
          grand_total,
          items: itemsRaw,
          payment_method,
          payment_COA,
          vendor_COA,
          number,
          status,
          installment_type,
          ppn,
          pph_type,
          pph,
          dpp,
          tax_method,
          ppn_percentage,
          pph_percentage,
          total,
          payment_amount,
          paid_amount,
          payment_name,
          remain_balance,
        } = billing;

        // ====== Initialize Journal Line Entries and Totals ======
        const lineEntries = [];
        let totalInventory = 0;

        let discountPayment = 0;
        let alerts = [];
        let paymentDates = [];
        const currentDate = new Date().toISOString().split("T")[0]; // contoh: "2025-10-10"
        let installment_count = billing.installment_count || 0;
        let discountRate = 0;
        let discountDays = 0;
        let netDays = 0;
        let hasFinalPay;

        // ====== Global Discount ======
        if (terms) {
          // Example: "2/10, n/30"
          const match = billing.terms.match(/(\d+)\/(\d+),\s*n\/(\d+)/);

          if (match) {
            discountRate = parseFloat(match[1]); // e.g., 2 (%)
            discountDays = parseInt(match[2], 10); // e.g., 10 (discount days)
            netDays = parseInt(match[3], 10); // e.g., 30 (final due days)
          }
        }

        // ====== Installment Payment Handling ======
        let totalPaid = 0;
        let paymentAmount = [];
        let currentPaymentLabel = null; // 'full_pay' | 'first_pay' | 'second_pay' | 'third_pay' | 'final_pay'

        if (!paid_amount || paid_amount <= 0) {
          alerts.push("Invalid paid amount. Please provide a valid positive number.");
          return res.status(400).json({ message: alerts.join(" ") });
        }

        if (billing.payment_amount && Array.isArray(billing.payment_amount)) {
          // Hitung total dari semua installment yang sudah ada
          totalPaid = billing.payment_amount.reduce((sum, obj) => {
            const value = Object.values(obj)[0];
            return sum + Number(value || 0);
          }, 0);
          paymentAmount = [...billing.payment_amount];
        }

        // === FULL PAYMENT HANDLING ===
        if (payment_method === "Full Payment") {
          if (paid_amount !== grand_total) {
            alerts.push(`The amount you paid is insufficient for the Full Payment method. You must pay exactly ${grand_total.toLocaleString("id-ID")}.`);
            return res.status(400).json({ message: alerts.join(" ") });
          }

          // Simpan pembayaran
          paymentAmount.push({ full_pay: paid_amount });
          installment_count = 1;
          currentPaymentLabel = "full_pay";
          alerts.push("Payment fully settled with Full Payment.");
        }

        // === PARTIAL PAYMENT HANDLING ===
        else if (payment_method === "Partial Payment") {
          const minDp = grand_total * 0.1;
          hasFinalPay = paymentAmount.some((obj) => obj.hasOwnProperty("final_pay"));

          // Jika installment_count belum ada (pembayaran pertama)
          if (installment_count === 0) {
            if (paid_amount === grand_total) {
              alerts.push("The amount you paid is enough for Full Payment. Please change your payment method to 'Full Payment'.");
              return res.status(400).json({ message: alerts.join(" ") });
            }

            if (paid_amount < minDp) {
              alerts.push(`The DP amount entered is too small. Minimum 10% (${minDp.toLocaleString("id-ID")}) of the total bill is required.`);
              return res.status(400).json({ message: alerts.join(" ") });
            }

            paymentAmount.push({ first_pay: paid_amount });
            installment_count += 1;
            currentPaymentLabel = "first_pay";
            alerts.push(`First installment recorded: ${paid_amount.toLocaleString("id-ID")}.`);
          }

          // Jika installment_count = 1 dan belum final
          else if (installment_count === 1 && !hasFinalPay) {
            const totalAfterPayment = totalPaid + paid_amount;

            const remaining = grand_total - totalPaid;

            // Tambahkan validasi jika melebihi sisa
            if (paid_amount > remaining) {
              return res.status(404).json({
                error: true,
                message: `The payment amount exceeds the remaining balance of ${remaining.toLocaleString("id-ID")}. Please check again.`,
              });
            }

            if (totalAfterPayment === remaining) {
              paymentAmount.push({ final_pay: paid_amount });
              currentPaymentLabel = "final_pay";
              alerts.push("Final payment completed. Payment fully settled.");
            } else {
              paymentAmount.push({ second_pay: paid_amount });
              installment_count += 1;
              currentPaymentLabel = "second_pay";
              alerts.push(`Second installment recorded: ${paid_amount.toLocaleString("id-ID")}. Remaining balance = ${(grand_total - totalAfterPayment).toLocaleString("id-ID")}.`);
            }
          }

          // Jika installment_count = 2 dan belum final
          else if (installment_count === 2 && !hasFinalPay) {
            const totalAfterPayment = totalPaid + paid_amount;
            const remaining = grand_total - totalPaid;

            // Tambahkan validasi jika melebihi sisa
            if (paid_amount > remaining) {
              return res.status(404).json({
                error: true,
                message: `The payment amount exceeds the remaining balance of ${remaining.toLocaleString("id-ID")}. Please check again.`,
              });
            }

            if (totalAfterPayment === remaining) {
              paymentAmount.push({ final_pay: paid_amount });
              currentPaymentLabel = "final_pay";
              alerts.push("Final payment completed. Payment fully settled.");
            } else {
              paymentAmount.push({ third_pay: paid_amount });
              installment_count += 1;
              currentPaymentLabel = "third_pay";
              alerts.push(`Third installment recorded: ${paid_amount.toLocaleString("id-ID")}. Remaining balance = ${(grand_total - totalAfterPayment).toLocaleString("id-ID")}.`);
            }
          }

          // Jika installment_count = 3 dan belum final
          else if (installment_count === 3 && !hasFinalPay) {
            const totalAfterPayment = totalPaid + paid_amount;
            const remaining = grand_total - totalPaid;

            // Tambahkan validasi jika melebihi sisa
            if (paid_amount > remaining) {
              return res.status(404).json({
                error: true,
                message: `The payment amount exceeds the remaining balance of ${remaining.toLocaleString("id-ID")}. Please check again.`,
              });
            }

            if (totalAfterPayment !== grand_total) {
              alerts.push(`The amount you paid is not enough. This should be the final payment to complete your balance of ${remaining.toLocaleString("id-ID")}.`);
              return res.status(400).json({ message: alerts.join(" ") });
            }

            paymentAmount.push({ final_pay: paid_amount });
            currentPaymentLabel = "final_pay";
            installment_count += 1;
            alerts.push("Final payment completed. Payment fully settled.");
          }

          // Jika sudah ada final_pay
          else if (hasFinalPay) {
            alerts.push("This invoice has already been fully paid. No further payment is required.");
            return res.status(400).json({ message: alerts.join(" ") });
          }

          // Jika lebih dari 4 kali cicilan
          else if (installment_count > 3) {
            alerts.push("Installments cannot exceed 3 installments + Final Payment.");
            return res.status(400).json({ message: alerts.join(" ") });
          }
        }

        // Setelah paymentAmount sukses ditentukan, baru catat paymentDates sinkron dengan paymentAmount
        if (billing.payment_date && Array.isArray(billing.payment_date)) {
          paymentDates = [...billing.payment_date];
        }

        if (payment_method === "Full Payment") {
          paymentDates = [{ full_pay: currentDate }];
        } else if (payment_method === "Partial Payment" && currentPaymentLabel) {
          paymentDates.push({ [currentPaymentLabel]: currentDate });
        }

        // Perhitungan diskon dan pesan terkait jatuh tempo dilakukan menggunakan currentDate
        if (discountDays && netDays) {
          const invoiceDateObj = new Date(billing.invoice_date);
          const paymentDateObj = new Date(currentDate);
          const diffDays = Math.ceil((paymentDateObj - invoiceDateObj) / (1000 * 60 * 60 * 24));
          const daysLeft = netDays - diffDays;

          // Update flag setelah paymentAmount diperbarui
          hasFinalPay = Array.isArray(paymentAmount) && paymentAmount.some((p) => Object.prototype.hasOwnProperty.call(p, "final_pay"));
          const hasThirdPay = Array.isArray(paymentAmount) && paymentAmount.some((p) => Object.prototype.hasOwnProperty.call(p, "third_pay"));

          // Discount eligibility
          if (diffDays <= discountDays) {
            discountPayment = (total * discountRate) / 100;
            alerts.push(`You are eligible for a ${discountRate}% discount. ${discountDays - diffDays} days left to claim it.`);
          }

          // Reminder messages for partial payment
          if (payment_method === "Partial Payment" && !hasFinalPay) {
            if (daysLeft > 0) {
              alerts.push(`Partial payment recorded. You have ${daysLeft} day${daysLeft > 1 ? "s" : ""} left before the due date (n/${netDays}).`);
            } else if (hasThirdPay && daysLeft <= 0) {
              alerts.push("Partial payment recorded (third pay). Invoice is already overdue — final payment is required soon.");
            }
          }
        }

        // Hitung total pembayaran setelah update untuk menentukan remaining balance
        const totalPaidUpdated = Array.isArray(paymentAmount) ? paymentAmount.reduce((sum, obj) => sum + Number(Object.values(obj)[0] || 0), 0) : 0;

        const newRemainBalance = Number(grand_total) - Number(totalPaidUpdated);

        // Simpan kembali data ke database (payment_amount, installment_count, payment_date, dan remain_balance)
        const { error: updateBillingError } = await supabase
          .from("billing_invoice")
          .update({
            payment_amount: paymentAmount,
            installment_count: installment_count,
            payment_date: paymentDates,
            remain_balance: newRemainBalance,
          })
          .eq("id", billing.id);

        if (updateBillingError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update billing invoice: " + updateBillingError.message,
          });
        }

        // ====== Total Qty Calculation (for proportional discount/penalty allocation) ======
        const totalQty = itemsRaw.reduce((sum, i) => sum + (i.qty - (i.return_unit || 0)), 0);

        // Buat journal entry utama
        const { data: journal, error: journalError } = await supabase
          .from("journal_entries")
          .insert({
            transaction_number: `BILINV-${number}-${installment_count}`,
            description: `Journal for Billing Invoice ${billingId}`,
            user_id: user.id,
            entry_date: new Date().toISOString().split("T")[0],
            created_at: new Date(),
          })
          .select()
          .single();

        if (journalError) {
          return res.status(500).json({
            error: true,
            message: "Failed to create journal entry: " + journalError.message,
          });
        }

        const ppnRate = Number(billing.ppn_percentage) / 100;
        const ppnPct = Number(billing.ppn_percentage) || 0;

        // Apply special PPN rules for 11% / 12% consistency with Billing Order logic
        if (billing.tax_method === "Before Calculate") {
          if (ppnPct === 11) {
            // Treat total as DPP when ppn_percentage === 11
            dpp = Number(billing.total) || 0;
            ppn = Math.round(ppnRate * dpp);
            pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
          } else if (ppnPct === 12) {
            // Use 11/12 * total as DPP when ppn_percentage === 12
            dpp = (11 / 12) * Number(billing.total || 0);
            ppn = Math.round(ppnRate * dpp);
            pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
          } else {
            // Fallback/legacy behaviour
            dpp = (11 / 12) * Number(billing.total || 0);
            ppn = Math.round(ppnRate * dpp);
            pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
          }
        } else if (billing.tax_method === "After Calculate") {
          if (ppnPct === 11) {
            // Compute DPP by dividing by (1 + ppnRate) when 11%
            dpp = Number(billing.total || 0) / (1 + ppnRate);
            ppn = Math.round(ppnRate * dpp);
            pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
          } else if (ppnPct === 12) {
            // Use 11/12 * total as DPP when ppn_percentage === 12
            dpp = (11 / 12) * Number(billing.total || 0);
            ppn = Math.round(ppnRate * dpp);
            pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
          } else {
            // Fallback behaviour
            dpp = Number(billing.total || 0) / (1 + ppnRate);
            ppn = Math.round(ppnRate * dpp);
            pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
          }
        }

        // ====== Journal Entries: Full Payment ======
        if (payment_method === "Full Payment") {
          // Debit Vendor
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: vendor_COA,
            description: vendor_name,
            debit: total,
            credit: 0,
            user_id: user.id,
          });

          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: 160101,
            description: "VAT In",
            debit: ppn,
            credit: 0,
            user_id: user.id,
          });

          // Credit Cash & Bank
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: payment_COA,
            description: `${payment_name}`,
            debit: 0,
            credit: total + ppn,
            user_id: user.id,
          });

          if (pph > 0) {
            // Prepaid PPh 23
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: 160103,
              description: "Prepaid PPh 23",
              debit: pph,
              credit: 0,
              user_id: user.id,
            });

            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: payment_COA,
              description: `${payment_name}`,
              debit: 0,
              credit: pph,
              user_id: user.id,
            });
          }
        }

        // ====== Journal Entries: Partial Payment ======
        else if (payment_method === "Partial Payment") {
          // Example: partialAmount is the actual paid amount
          const partialAmount = paid_amount || 0;

          if (billing.tax_method === "Before Calculate") {
            if (ppnPct === 11) {
              dpp = Number(partialAmount) || 0;
              ppn = Math.round(ppnRate * dpp);
              pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
            } else if (ppnPct === 12) {
              dpp = (11 / 12) * Number(partialAmount || 0);
              ppn = Math.round(ppnRate * dpp);
              pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
            } else {
              dpp = (11 / 12) * Number(partialAmount || 0);
              ppn = Math.round(ppnRate * dpp);
              pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
            }
          } else if (billing.tax_method === "After Calculate") {
            if (ppnPct === 11) {
              dpp = Number(partialAmount || 0) / (1 + ppnRate);
              ppn = Math.round(ppnRate * dpp);
              pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
            } else if (ppnPct === 12) {
              dpp = (11 / 12) * Number(partialAmount || 0);
              ppn = Math.round(ppnRate * dpp);
              pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
            } else {
              dpp = Number(partialAmount || 0) / (1 + ppnRate);
              ppn = Math.round(ppnRate * dpp);
              pph = Math.round((dpp * Number(billing.pph_percentage)) / 100);
            }
          }

          if (partialAmount > 0) {
            // Debit Vendor
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: vendor_COA,
              description: vendor_name,
              debit: partialAmount,
              credit: 0,
              user_id: user.id,
            });

            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: 160101,
              description: "VAT In",
              debit: ppn,
              credit: 0,
              user_id: user.id,
            });

            // Credit Cash & Bank
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: payment_COA,
              description: `${payment_name}`,
              debit: 0,
              credit: partialAmount + ppn,
              user_id: user.id,
            });

            if (pph > 0 && hasFinalPay) {
              // Prepaid PPh 23
              lineEntries.push({
                journal_entry_id: journal.id,
                account_code: 160103,
                description: "Prepaid PPh 23",
                debit: pph,
                credit: 0,
                user_id: user.id,
              });

              lineEntries.push({
                journal_entry_id: journal.id,
                account_code: payment_COA,
                description: `${payment_name}`,
                debit: 0,
                credit: pph,
                user_id: user.id,
              });
            }
          } else {
            alerts.push("Warning: Partial payment amount is missing or zero.");
          }
        }

        console.log("DEBUG >> discountPayment:", discountPayment);

        let totalItemDisc = 0;

        // ====== Journal Entries: Discount Payment Allocation ======
        if (discountPayment > 0) {
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: 160101,
            description: "VAT In",
            debit: 0,
            credit: Math.round(ppn - (ppn * discountRate) / 100),
            user_id: user.id,
          });

          // Credit allocation to Inventory (proportional per item)
          for (const item of itemsRaw) {
            console.log("DEBUG >> item for discount allocation:", item);
            console.log("DEBUG >> item.qty for discount allocation:", item.qty);
            const itemDisc = Number((discountPayment / totalQty) * (item.qty - item.return_unit));
            totalItemDisc += itemDisc;
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: item.coa,
              description: `Inventory - ${item.item_name}`,
              debit: 0,
              credit: Math.round(itemDisc),
              user_id: user.id,
            });
          }

          // Debit Cash & Bank
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: payment_COA,
            description: `${payment_name}`,
            debit: Math.round(discountPayment + (ppn - (ppn * discountRate) / 100)),
            credit: 0,
            user_id: user.id,
          });
        }

        // ====== Update status berdasarkan metode pembayaran ======
        let newStatus = billing.status; // default tetap status lama

        if (payment_method === "Full Payment") {
          newStatus = "Completed";
        } else if (payment_method === "Partial Payment") {
          if (hasFinalPay) {
            newStatus = "Completed";
          } else {
            newStatus = "Pending";
          }
        }

        // Update status di database
        const { error: updateStatusError } = await supabase.from("billing_invoice").update({ status: newStatus }).eq("id", billing.id);

        if (updateStatusError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update billing status: " + updateStatusError.message,
          });
        }

        console.log(`DEBUG >> Updated billing status to: ${newStatus}`);

        // Insert ke Supabase
        const { error: insertError } = await supabase.from("journal_entry_lines").insert(lineEntries);

        if (insertError) {
          return res.status(500).json({
            error: true,
            message: "Failed to insert journal lines: " + insertError.message,
          });
        }

        return res.status(201).json({
          error: false,
          message: "Journal Entries created successfully",
          data: {
            journal,
            lines: lineEntries,
          },
          alerts: alerts,
        });
      }

      // Approval Billing Order Endpoint
      case "sendBillingOrderToCOA": {
        if (method !== "POST") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for sendBillingOrderToCOA.",
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        // Get user
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        // Get user role
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        // Ambil billing order ID
        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Billing Order ID" });
        }
        const billingOrderId = String(id);

        // Ambil billing order dari DB
        const { data: billingOrder, error: billingOrderError } = await supabase.from("billing_order").select("*").eq("id", id).ilike("status", "pending").single();

        if (billingOrderError || !billingOrder) {
          return res.status(404).json({ error: true, message: "Billing Order not found or already completed" });
        }

        // Make journal entry
        const { data: journal, error: journalError } = await supabase
          .from("journal_entries")
          .insert({
            transaction_number: `ORD-${billingOrder.number}`,
            description: `Journal for Billing Order ${billingOrderId}`,
            user_id: user.id,
            entry_date: new Date().toISOString().split("T")[0],
            created_at: new Date(),
          })
          .select()
          .single();

        if (journalError) {
          return res.status(500).json({
            error: true,
            message: "Failed to create journal entry: " + journalError.message,
          });
        }

        const lineEntries = [];

        // Debit Purchase Prepaid Vendor
        lineEntries.push({
          journal_entry_id: journal.id,
          account_code: billingOrder.installment_COA,
          description: billingOrder.installment_name,
          debit: billingOrder.installment_amount,
          credit: 0,
          user_id: user.id,
          transaction_number: `ORD-${billingOrder.number}`,
        });

        lineEntries.push({
          journal_entry_id: journal.id,
          account_code: 160101,
          description: "VAT In",
          debit: billingOrder.ppn,
          credit: 0,
          user_id: user.id,
          transaction_number: `ORD-${billingOrder.number}`,
        });

        // Credit Cash & Bank
        lineEntries.push({
          journal_entry_id: journal.id,
          account_code: billingOrder.payment_COA,
          description: billingOrder.payment_name,
          debit: 0,
          credit: billingOrder.paid_amount,
          user_id: user.id,
          transaction_number: `ORD-${billingOrder.number}`,
        });

        // Insert ke Supabase
        const { error: insertError } = await supabase.from("journal_entry_lines").insert(lineEntries);

        if (insertError) {
          return res.status(500).json({
            error: true,
            message: "Failed to insert journal lines: " + insertError.message,
          });
        }

        // Update status
        const { error: updateStatusError } = await supabase.from("billing_order").update({ status: "Completed" }).eq("id", id);

        if (updateStatusError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update billing status: " + updateError.message,
          });
        }

        // Jika ada billing_invoice yang terkait dengan nomor ini, catat pembayaran (down payment)
        try {
          const { data: relatedBillingInv, error: relatedBillingErr } = await supabase.from("billing_invoice").select("*").eq("number", billingOrder.number).maybeSingle();

          if (!relatedBillingErr && relatedBillingInv) {
            // Tentukan nilai yang dibayarkan untuk billing order ini
            let paidAmount = Number(billingOrder.paid_amount || 0);
            // Jika paid_amount tidak tersimpan, coba hitung dari installment_amount + ppn (jika tersedia)
            if (!paidAmount || paidAmount === 0) {
              const installment = Number(billingOrder.installment_amount || 0);
              const ppn = Number(billingOrder.ppn || 0);
              if (installment > 0) paidAmount = installment + ppn;
            }

            // Ambil payment_amount yang sudah ada (disimpan sebagai array JSON), lalu tambahkan entry baru
            const existingPayments = Array.isArray(relatedBillingInv.payment_amount) ? [...relatedBillingInv.payment_amount] : [];
            existingPayments.push({ billing_order_id: billingOrder.id, amount: Math.round(paidAmount), date: new Date().toISOString() });

            const totalPaid = existingPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
            const grandTotal = Number(relatedBillingInv.grand_total || 0);
            const newRemain = Math.max(0, Math.round(grandTotal - totalPaid));

            const newStatus = newRemain <= 0 ? "Completed" : totalPaid > 0 ? "Pending" : relatedBillingInv.status || "Unpaid";

            const { error: updateBillingInvErr } = await supabase.from("billing_invoice").update({ payment_amount: existingPayments, remain_balance: newRemain, status: newStatus }).eq("id", relatedBillingInv.id);

            if (updateBillingInvErr) {
              console.error("Failed to update related billing_invoice with down payment:", updateBillingInvErr.message);
            }
          }
        } catch (e) {
          console.error("Error while applying billing order payment to billing_invoice:", e.message || e);
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Approved Billing Order & Send Billing Order to COA",
            http_method: req.method,
            updated_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({
          error: false,
          message: "Billing order approved successfully",
          data: {
            journal,
            lines: lineEntries,
          },
        });
      }

      // Approval Invoice Endpoint
      case "sendInvoiceToCOA": {
        if (method !== "POST") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for sendInvoiceToCOA.",
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        // Get user
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        // Get user role
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        // Ambil invoice ID
        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Invoice ID" });
        }
        const invoiceId = String(id);

        // 1. Ambil invoice dari DB
        const { data: invoice, error: invoiceError } = await supabase.from("invoices").select("*").eq("id", id).ilike("status", "pending").single();

        if (invoiceError || !invoice) {
          return res.status(404).json({ error: true, message: "Invoice not found or already completed/rejected" });
        }

        let lineEntries = [];

        const { items, freight_in, insurance, vendor_COA, vendor_name, number } = invoice;

        // 2. Hitung total qty semua item
        const totalQty = items.reduce((sum, i) => sum + i.qty, 0);

        const freightShare = totalQty > 0 ? freight_in / totalQty : 0;
        const insuranceShare = totalQty > 0 ? insurance / totalQty : 0;

        // 3. Buat Journal Entry
        const { data: journal, error: journalError } = await supabase
          .from("journal_entries")
          .insert([
            {
              entry_date: new Date().toISOString().split("T")[0],
              description: `Journal for Invoice ${id}`,
              transaction_number: `INV-${number}`,
              user_id: user.id,
            },
          ])
          .select()
          .single();

        if (journalError || !journal) {
          return res.status(500).json({
            error: true,
            message: "Failed to create journal entry: " + journalError.message,
          });
        }

        // 4. Hitung nilai inventory per item
        let totalInventory = 0;
        const inventoryRecords = [];

        for (const item of items) {
          const { coa, item_name, sku, qty, unit, price, disc_item, disc_item_type, return_unit } = item;

          // Hitung gross & diskon per item
          let discountedPrice;
          let gross = 0;
          let returnAmount = 0;

          if (disc_item_type === "percentage") {
            discountedPrice = price - (price * disc_item) / 100;
            gross = (discountedPrice + freightShare + insuranceShare) * qty;
          } else if (disc_item_type === "nominal") {
            gross = (price + freightShare + insuranceShare - disc_item) * qty;
          }

          if (return_unit > 0) {
            let returnedDiscountedPrice = disc_item_type === "percentage" ? price - (price * disc_item) / 100 : price - (disc_item_type === "nominal" ? disc_item / qty : 0);

            console.log("Ini returnedDiscountedPrice = ", returnedDiscountedPrice);

            returnAmount = (returnedDiscountedPrice + (freightShare || 0) + (insuranceShare || 0)) * return_unit;
          }

          // Hitung net
          const net = gross - returnAmount;

          totalInventory += net;

          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: coa,
            description: `Inventory - ${item_name}`,
            debit: Math.round(net),
            credit: 0,
            user_id: user.id,
            transaction_number: `INV-${number}`,
          });

          // === INVENTORY MANAGEMENT: AVERAGE DOWN METHOD ===
          const inventoryDate = invoice.date; // Gunakan date dari invoice, bukan tanggal hari ini
          const yearMonth = inventoryDate.slice(0, 7); // Format: YYYY-MM
          // Hitung last day of month dinamically (30 atau 31, atau 28/29 Februari)
          const [__y, __m] = yearMonth.split("-");
          const endDay = new Date(Number(__y), Number(__m), 0).getDate();
          const endOfMonth = `${yearMonth}-${String(endDay).padStart(2, "0")}`;
          const randomNum = Math.floor(100000 + Math.random() * 900000);

          // Cek apakah sudah ada data inventory di bulan dan tahun yang sama untuk item ini
          const { data: existingInMonth, error: countErr } = await supabase
            .from("inventory")
            .select("*")
            .eq("stock_name", item_name)
            .gte("inventory_date", `${yearMonth}-01`)
            .lte("inventory_date", endOfMonth)
            .order("inventory_date", { ascending: false });

          if (countErr) throw new Error("Failed to check existing inventory in month: " + countErr.message);

          const isFirstInMonth = !existingInMonth || existingInMonth.length === 0;
          const purchaseCount = existingInMonth ? existingInMonth.length : 0;

          // Tentukan description berdasarkan apakah ini data pertama di bulan tersebut
          const descText = isFirstInMonth ? "Persediaan Awal" : `Purchase Invoice ${purchaseCount + 1}`;

          // Ambil data inventory terakhir (dari bulan sebelumnya atau bulan yang sama)
          const { data: prevStock, error: prevError } = await supabase.from("inventory").select("*").eq("stock_name", item_name).order("inventory_date", { ascending: false }).limit(1).maybeSingle();

          if (prevError) throw new Error("Error fetching previous inventory: " + prevError.message);

          // Variabel stok lama (dari data sebelumnya, jika ada)
          const oldTotalQty = prevStock?.total_qty || 0;
          const oldTotalStock = prevStock?.total_stock || 0;
          const oldAvgPerUnit = prevStock?.avg_per_unit || 0;

          // Hitung disc_per_item sesuai tipe diskon
          let discPerItem = 0;
          if (disc_item_type === "percentage") {
            discPerItem = price * (disc_item / 100);
          } else if (disc_item_type === "nominal") {
            discPerItem = disc_item || 0;
          }

          // Hitung disc_payment (dari invoice level jika ada)
          // Asumsi: disc_payment dibagi rata per item berdasarkan qty
          const discPayment = 0; // Bisa diambil dari invoice.discount_payment jika ada

          // Hitung nett_purchase
          const nettPurchase = (qty - return_unit) * price - discPerItem + freightShare * qty + insuranceShare * qty - discPayment;

          // Hitung nett_price_item
          const qtyAfterReturn = qty - (return_unit || 0);
          const nettPriceItem = qtyAfterReturn > 0 ? nettPurchase / qtyAfterReturn : 0;

          // Tentukan price_sale
          let priceSale = 0;
          if (isFirstInMonth) {
            // Data pertama: price_sale = price_purchase
            priceSale = price;
          } else {
            // Data kedua dan seterusnya: price_sale = avg_per_unit dari data sebelumnya
            priceSale = oldAvgPerUnit;
          }

          // Hitung quantity_sale dan return_sale (default 0 karena ini purchase, bukan sale)
          const quantitySale = 0;
          const returnSale = 0;

          // Hitung total_sale
          const totalSale = priceSale * (quantitySale - returnSale);

          // Hitung total_qty baru
          let newTotalQty = 0;
          if (isFirstInMonth) {
            // Data pertama: total_qty = quantity_purchase - return_purchase - quantity_sale
            newTotalQty = qty - (return_unit || 0) - quantitySale;
          } else {
            // Data kedua dst: total_qty = total_qty lama + quantity_purchase - return_purchase - quantity_sale
            newTotalQty = oldTotalQty + qty - (return_unit || 0) - quantitySale;
          }

          // Hitung total_stock baru
          let newTotalStock = 0;
          if (isFirstInMonth) {
            // Data pertama: total_stock = nett_purchase - total_sale
            newTotalStock = nettPurchase - totalSale;
          } else {
            // Data kedua dst: total_stock = total_stock lama + nett_purchase - total_sale
            newTotalStock = oldTotalStock + nettPurchase - totalSale;
          }

          // Hitung avg_per_unit baru
          const newAvgPerUnit = newTotalQty > 0 ? newTotalStock / newTotalQty : 0;

          // Hitung total_cogs dengan menjumlahkan semua total_sale di bulan ini
          // Ambil semua data inventory di bulan yang sama untuk item ini
          const { data: allInMonthForCogs, error: cogsErr } = await supabase.from("inventory").select("total_sale").eq("stock_name", item_name).gte("inventory_date", `${yearMonth}-01`).lte("inventory_date", endOfMonth);

          if (cogsErr) throw new Error("Failed to calculate total_cogs: " + cogsErr.message);

          // Jumlahkan semua total_sale yang sudah ada + total_sale yang baru
          let calculatedCogs = totalSale; // Mulai dengan total_sale transaksi ini
          if (allInMonthForCogs && allInMonthForCogs.length > 0) {
            calculatedCogs += allInMonthForCogs.reduce((sum, record) => sum + (record.total_sale || 0), 0);
          }

          // Insert ke tabel inventory
          const insertData = {
            number: `INV-${randomNum}`,
            user_id: user.id,
            stock_name: item_name,
            inventory_date: inventoryDate,
            description: descText,
            quantity_purchase: qty,
            // Stock movement for this inventory record (positive for purchase)
            stock_movement: Number(qty) || 0,
            price_purchase: price,
            return_purchase: return_unit || 0,
            quantity_sale: quantitySale,
            return_sale: returnSale,
            disc_per_item: Math.round(discPerItem),
            freight_in: Math.round(freightShare * qty),
            insurance: Math.round(insuranceShare * qty),
            disc_payment: Math.round(discPayment),
            nett_purchase: Math.round(nettPurchase),
            nett_quantity: Math.round(qtyAfterReturn),
            nett_price_item: Math.round(nettPriceItem),
            price_sale: Math.round(priceSale),
            total_sale: Math.round(totalSale),
            type: "Purchase",
            total_cogs: Math.round(calculatedCogs),
            total_qty: newTotalQty,
            total_stock: Math.round(newTotalStock),
            avg_per_unit: Math.round(newAvgPerUnit),
            created_at: new Date().toISOString(),
          };

          // Simpan data
          const { error: insertErr } = await supabase.from("inventory").insert([insertData]);

          if (insertErr) throw new Error("Failed to insert inventory: " + insertErr.message);

          console.log(`${item_name} updated — Desc: ${descText}, New Avg: ${newAvgPerUnit.toLocaleString("id-ID")}`);

          // === INSERT KE TABLE STOCK (JIKA BELUM ADA) ===
          const { data: existingStock, error: stockCheckErr } = await supabase.from("stock").select("*").eq("name", item_name).maybeSingle();

          if (stockCheckErr) {
            throw new Error("Failed to check existing stock: " + stockCheckErr.message);
          }

          // Hanya insert jika belum ada SKU yang sama
          if (!existingStock) {
            const { error: stockInsertErr } = await supabase.from("stock").insert([
              {
                name: item_name,
                sku: sku,
                unit: unit,
                stock_COA: coa,
                user_id: user.id,
                created_at: new Date().toISOString(),
              },
            ]);

            if (stockInsertErr) {
              throw new Error("Failed to insert new stock record: " + stockInsertErr.message);
            }

            console.log(`New stock added: ${item_name} (${sku})`);
          } else {
            console.log(`Stock for ${item_name} (${sku}) already exists, skipped insert.`);
          }
        }

        // Insert data ke inventory table
        if (inventoryRecords.length > 0) {
          const { error: inventoryInsertError } = await supabase.from("inventory").insert(inventoryRecords);

          if (inventoryInsertError) {
            return res.status(404).json({
              error: true,
              message: "Failed to insert inventory records: " + inventoryInsertError.message,
            });
          }
        }

        // 5. Kredit: AP - Vendor
        const totalDebit = totalInventory;
        lineEntries.push({
          journal_entry_id: journal.id,
          account_code: vendor_COA,
          description: vendor_name,
          debit: 0,
          credit: Math.round(totalDebit),
          user_id: user.id,
          transaction_number: `INV-${number}`,
        });

        // 6. Kredit: Installment - Vendor
        const { data: sameNumberOrders, error: sameNumberError } = await supabase.from("billing_order").select("id, installment_name, installment_COA, installment_amount").eq("number", number);

        if (sameNumberError) {
          return res.status(500).json({ error: true, message: "Failed to check billing_order by number" });
        }

        if (sameNumberOrders && sameNumberOrders.length > 0) {
          for (const order of sameNumberOrders) {
            const { installment_COA, installment_name, installment_amount } = order;
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: installment_COA,
              description: installment_name,
              debit: 0,
              credit: Math.round(installment_amount),
              user_id: user.id,
              transaction_number: `INV-${number}`,
            });
          }
        }

        const { error: insertError } = await supabase.from("journal_entry_lines").insert(lineEntries);

        if (insertError) {
          return res.status(500).json({
            error: true,
            message: "Failed to insert journal lines: " + insertError.message,
          });
        }

        // Check billing_order for any down-payments (same invoice number)
        let billOrderAmount = 0;
        try {
          const { data: ordersWithSameNumber, error: ordersErr } = await supabase.from("billing_order").select("paid_amount").eq("number", invoice.number);

          if (!ordersErr && Array.isArray(ordersWithSameNumber) && ordersWithSameNumber.length > 0) {
            billOrderAmount = ordersWithSameNumber.reduce((sum, r) => sum + (Number(r.paid_amount) || 0), 0);
          }
        } catch (e) {
          console.error("Error checking billing_order for same number:", e.message || e);
          billOrderAmount = 0;
        }

        // Adjust grand_total to subtract bill_order_amount (if any)
        const originalGrand = Number(invoice.grand_total || 0);
        const adjustedGrand = Math.round(originalGrand - billOrderAmount);

        const { error } = await supabase.from("billing_invoice").insert([
          {
            user_id: user.id,
            vendor_name: invoice.vendor_name,
            invoice_date: invoice.date,
            terms: invoice.terms,
            // store the grand_total after deducting any billing_order paid amounts
            grand_total: adjustedGrand,
            items: invoice.items,
            type: "Billing Invoice",
            number: invoice.number,
            status: "Unpaid",
            due_date: invoice.due_date,
            ppn: invoice.ppn,
            pph_type: invoice.pph_type,
            pph: invoice.pph,
            dpp: invoice.dpp,
            tax_method: invoice.tax_method,
            ppn_percentage: invoice.ppn_percentage,
            pph_percentage: invoice.pph_percentage,
            total: invoice.total,
            // store bill order aggregated paid amount
            bill_order_amount: billOrderAmount,
          },
        ]);

        if (error) {
          return res.status(500).json({
            error: true,
            message: "Failed to create billing summary: " + error.message,
          });
        }

        const { data: updated, error: updateStatusError } = await supabase.from("invoices").update({ status: "Completed" }).eq("id", invoiceId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update invoice status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Approved Invoice, Send Invoice to COA, & Create Billing Summary Invoice",
            http_method: req.method,
            updated_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({
          error: false,
          message: "Invoices approved successfully",
          data: {
            journal,
            lines: lineEntries,
          },
        });
      }

      // Adjustment Stock Endpoint
      case "adjustmentStock": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for adjustmentStock." });
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

        // Expect body: { month: 'YYYY-MM', stock_name: 'Item name', nett_purchase: number }
        const { month, stock_name, nett_purchase } = req.body;

        if (!month) return res.status(400).json({ error: true, message: "month (YYYY-MM) is required" });
        if (!stock_name) return res.status(400).json({ error: true, message: "stock_name is required" });
        if (nett_purchase === undefined || nett_purchase === null) return res.status(400).json({ error: true, message: "nett_purchase is required (can be negative)" });

        const toNum = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

        try {
          // build date range for the month
          const startDate = `${month}-01`;
          const endDate = `${month}-31`;

          // Fetch latest inventory record in that month for the stock_name
          const { data: latestRec, error: latestErr } = await supabase
            .from("inventory")
            .select("*")
            .eq("stock_name", stock_name)
            .gte("inventory_date", startDate)
            .lte("inventory_date", endDate)
            .order("inventory_date", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (latestErr) return res.status(500).json({ error: true, message: "Failed to fetch inventory: " + latestErr.message });
          if (!latestRec) return res.status(404).json({ error: true, message: `No inventory records found for ${stock_name} in ${month}` });

          const oldTotalQty = toNum(latestRec.total_qty);
          const oldTotalStock = toNum(latestRec.total_stock);
          const oldAvgPerUnit = toNum(latestRec.avg_per_unit);

          // Sum total_sale (total_cogs) for the month for this stock
          const { data: salesInMonth, error: salesErr } = await supabase.from("inventory").select("total_sale").eq("stock_name", stock_name).gte("inventory_date", startDate).lte("inventory_date", endDate);

          if (salesErr) return res.status(500).json({ error: true, message: "Failed to calculate total_cogs: " + salesErr.message });

          const totalCogs = Array.isArray(salesInMonth) ? salesInMonth.reduce((s, r) => s + toNum(r.total_sale), 0) : 0;

          // Apply nett_purchase adjustment
          const adj = toNum(nett_purchase);
          const newTotalQty = oldTotalQty; // quantity unchanged by price adjustment
          const newTotalStock = oldTotalStock + adj;
          const newAvgPerUnit = newTotalQty > 0 ? newTotalStock / newTotalQty : 0;

          // Build total_nett JSON object to store
          const totalNett = {
            month,
            stock_name,
            old: {
              total_qty: oldTotalQty,
              total_stock: oldTotalStock,
              avg_per_unit: oldAvgPerUnit,
            },
            adjustment: {
              nett_purchase: adj,
            },
            new: {
              total_qty: newTotalQty,
              total_stock: newTotalStock,
              avg_per_unit: newAvgPerUnit,
            },
            total_cogs: totalCogs,
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          };

          // Update the latest inventory record's total_nett column (jsonb)
          const { error: updateErr } = await supabase.from("inventory").update({ total_nett: totalNett }).eq("id", latestRec.id);

          if (updateErr) return res.status(500).json({ error: true, message: "Failed to update inventory total_nett: " + updateErr.message });

          return res.status(200).json({ error: false, message: "Stock adjustment applied", data: { total_nett: totalNett } });
        } catch (err) {
          console.error("adjustmentStock error:", err);
          return res.status(500).json({ error: true, message: "Internal server error" });
        }
      }

      // Approval Shipment Endpoint
      case "sendShipment": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sendShipment." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Shipment ID" });
        }

        // 1. Get shipment with status "Pending"
        const { data: shipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", id).in("status", ["Pending", "pending", "Received", "received"]).single();

        if (fetchError || !shipment) {
          return res.status(404).json({ error: true, message: "Shipment not found or already completed/rejected" });
        }

        const shipmentId = String(id);

        // 2. Update the shipment status to "Completed"
        let newStatus;

        if (shipment.status === "Pending") {
          newStatus = "Received";
        } else if (shipment.status === "Received") {
          newStatus = "Completed";
        } else {
          return res.status(400).json({
            error: true,
            message: `Shipment already marked as ${shipmentData.status}`,
          });
        }

        // Update status di database
        const { data: updated, error: updateStatusError } = await supabase.from("shipments").update({ status: newStatus }).eq("id", shipmentId).select();

        if (updateStatusError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update shipment status: " + updateStatusError.message,
          });
        }

        // // 3. Generate new invoice number (similar with addNewInvoice endpoint)
        // const shipmentDate = new Date(shipment.date);
        // const shipmentMonth = shipmentDate.getMonth() + 1;
        // const shipmentYear = shipmentDate.getFullYear();
        // const prefix = `${shipmentYear}${String(shipmentMonth).padStart(2, "0")}`;
        // const prefixInt = parseInt(prefix + "0", 10);
        // const nextPrefixInt = parseInt(prefix + "9999", 10);

        // const { data: latestInvoice, error: invoiceError } = await supabase.from("invoices").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        // if (invoiceError) {
        //   return res.status(500).json({
        //     error: true,
        //     message: "Failed to create invoice from shipment: " + invoiceError.message,
        //   });
        // }

        // let counter = 1;
        // if (latestInvoice && latestInvoice.length > 0) {
        //   const lastNumber = latestInvoice[0].number.toString();
        //   const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
        //   counter = lastCounter + 1;
        // }

        // const nextNumber = parseInt(`${prefix}${counter}`, 10);

        // 4. Calculate again the grand total (optional)
        const updatedItems = shipment.items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          return {
            ...item,
            total_per_item: qty * unit_price,
          };
        });

        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Approved Shipment Data",
            http_method: req.method,
            updated_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Shipment approved successfully" });
      }

      // Approval Request Endpoint
      case "sendRequestToOrder": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sendRequestToOrder." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Request ID" });
        }

        // Get request with status "Pending"
        const { data: request, error: fetchError } = await supabase.from("requests").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !request) {
          return res.status(404).json({ error: true, message: "Request not found or already completed/rejected" });
        }

        const requestId = String(id);

        // // Generate new order number (similar with addNewOrder endpoint)
        // const requestDate = new Date(request.date);
        // const requestMonth = requestDate.getMonth() + 1;
        // const requestYear = requestDate.getFullYear();
        // const prefix = `${requestYear}${String(requestMonth).padStart(2, "0")}`;
        // const prefixInt = parseInt(prefix + "0", 10);
        // const nextPrefixInt = parseInt(prefix + "9999", 10);

        // const { data: latestOrder, error: orderError } = await supabase.from("orders").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        // if (orderError) {
        //   return res.status(500).json({
        //     error: true,
        //     message: "Failed to create order from request: " + orderError.message,
        //   });
        // }

        // let counter = 1;
        // if (latestOrder && latestOrder.length > 0) {
        //   const lastNumber = latestOrder[0].number.toString();
        //   const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
        //   counter = lastCounter + 1;
        // }

        // const nextNumber = parseInt(`${prefix}${counter}`, 10);

        // Calculate again the grand total (optional)
        const updatedItems = request.items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          return {
            ...item,
            total_per_item: qty * unit_price,
          };
        });

        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // Insert to orders
        const { error: insertError } = await supabase.from("orders").insert([
          {
            user_id: user.id,
            type: "Order",
            date: request.date,
            number: request.number,
            orders_date: request.date,
            due_date: request.due_date,
            status: "Completed",
            tags: request.tags,
            items: updatedItems,
            grand_total: request.grand_total,
            memo: "Catatan Add Order",
            vendor_name: request.vendor_name,
            vendor_address: request.vendor_address,
            vendor_phone: request.vendor_phone,
            installment_amount: request.installment_amount,
            tax_method: request.tax_method,
            ppn_percentage: request.ppn_percentage,
            pph_type: request.pph_type,
            pph_percentage: request.pph_percentage,
            dpp: request.dpp,
            ppn: request.ppn,
            pph: request.pph,
            total: request.total,
            attachment_url: request.attachment_url,
            ordered_by: request.requested_by,
            urgency: request.urgency,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert order: " + insertError.message });
        }

        if (request.installment_amount !== null && request.installment_amount !== 0) {
          const { error } = await supabase.from("billing_order").insert([
            {
              user_id: user.id,
              vendor_name: request.vendor_name,
              order_date: request.date,
              number: request.number,
              type: "Billing Order",
              items: request.items,
              installment_amount: request.installment_amount,
              grand_total: request.grand_total,
              status: "Pending",
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create billing summary: " + error.message,
            });
          }

          const { error: logErr } = await supabase.from("activity_logs").insert([
            {
              user_id: user.id,
              user_email: user.email,
              endpoint_name: "Add New Billing Order",
              http_method: req.method,
              created_at: new Date().toISOString(),
            },
          ]);

          if (logErr) {
            console.error("Failed to log activity:", logErr.message);
          }
        }

        // Update the request status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("requests").update({ status: "Completed" }).eq("id", requestId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update request status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Approved Request Data",
            http_method: req.method,
            updated_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Order created from request successfully" });
      }

      // Approval Quotation Endpoint
      case "sendQuotationToOffer": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sendQuotationToOffer." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Request ID" });
        }

        // Get quotation with status "Pending"
        const { data: quotation, error: fetchError } = await supabase.from("quotations_purchases").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !quotation) {
          return res.status(404).json({ error: true, message: "Quotation not found or already completed/rejected" });
        }

        const quotationId = String(id);

        // // Generate new offer number (similar with addNewOffer endpoint)
        // const quotationDate = new Date(quotation.quotation_date);
        // const quotationMonth = quotationDate.getMonth() + 1;
        // const quotationYear = quotationDate.getFullYear();
        // const prefix = `${quotationYear}${String(quotationMonth).padStart(2, "0")}`;
        // const prefixInt = parseInt(prefix + "0", 10);
        // const nextPrefixInt = parseInt(prefix + "9999", 10);

        // const { data: latestOffer, error: offerError } = await supabase.from("offers").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        // if (offerError) {
        //   return res.status(500).json({
        //     error: true,
        //     message: "Failed to create offer from quotation: " + offerError.message,
        //   });
        // }

        // let counter = 1;
        // if (latestOffer && latestOffer.length > 0) {
        //   const lastNumber = latestOffer[0].number.toString();
        //   const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
        //   counter = lastCounter + 1;
        // }

        // const nextNumber = parseInt(`${prefix}${counter}`, 10);

        // Calculate again the grand total (optional)
        const updatedItems = quotation.items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          return {
            ...item,
            total_per_item: qty * unit_price,
          };
        });

        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // Insert to offers
        const { error: insertError } = await supabase.from("offers").insert([
          {
            user_id: user.id,
            number: quotation.number,
            vendor_name: quotation.vendor_name,
            date: quotation.quotation_date,
            expiry_date: quotation.valid_until,
            status: "Completed",
            discount_terms: quotation.terms,
            items: updatedItems,
            total: quotation.total,
            memo: "Catatan Add Offer",
            type: "Offer",
            due_date: quotation.due_date,
            tags: quotation.tags,
            grand_total: quotation.grand_total,
            tax_method: quotation.tax_method,
            dpp: quotation.dpp,
            ppn: quotation.ppn,
            pph: quotation.pph,
            vendor_address: quotation.vendor_address,
            vendor_phone: quotation.vendor_phone,
            start_date: quotation.start_date,
            ppn_percentage: quotation.ppn_percentage,
            pph_percentage: quotation.pph_percentage,
            pph_type: quotation.pph_type,
            attachment_url: quotation.attachment_url,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert offer: " + insertError.message });
        }

        // Update the quotation status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("quotations_purchases").update({ status: "Completed" }).eq("id", quotationId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update quotation status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Approved Quotation Data",
            http_method: req.method,
            updated_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Offer created from quotation successfully" });
      }

      // Reject Billing Endpoint
      case "rejectBilling": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for rejectBilling." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Billing ID" });
        }

        // 1. Get billing with status "Pending"
        const { data: billing, error: fetchError } = await supabase.from("billing_invoice").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !billing) {
          return res.status(404).json({ error: true, message: "Billing not found or already completed/rejected" });
        }

        const billingId = String(id);

        // 2. Update the billing status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("billing_invoice").update({ status: "Rejected" }).eq("id", billingId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update billing status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Rejected Billing Data",
            http_method: req.method,
            updated_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Billing has been rejected successfully" });
      }

      // Reject Invoice Endpoint
      case "rejectInvoice": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for rejectInvoice." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Invoice ID" });
        }

        // 1. Get invoices with status "Pending"
        const { data: invoice, error: fetchError } = await supabase.from("invoices").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !invoice) {
          return res.status(404).json({ error: true, message: "Invoice not found or already completed/rejected" });
        }

        const invoiceId = String(id);

        // 2. Update the invoice status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("invoices").update({ status: "Rejected" }).eq("id", invoiceId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update invoice status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Rejected Invoice Data",
            http_method: req.method,
            created_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Invoice has been rejected successfully" });
      }

      // Reject Shipment Endpoint
      case "rejectShipment": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for rejectShipment." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Shipment ID" });
        }

        // 1. Get shipments with status "Pending"
        const { data: shipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", id).in("status", ["Pending", "pending", "Received", "received"]).single();

        if (fetchError || !shipment) {
          return res.status(404).json({ error: true, message: "Shipment not found or its status does not allow further updates" });
        }

        const shipmentId = String(id);

        // 2. Update the shipment status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("shipments").update({ status: "Rejected" }).eq("id", shipmentId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update shipment status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Rejected Shipment Data",
            http_method: req.method,
            created_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Shipment has been rejected successfully" });
      }

      // Reject Request Endpoint
      case "rejectRequest": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for rejectRequest." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Request ID" });
        }

        // 1. Get requests with status "Pending"
        const { data: request, error: fetchError } = await supabase.from("requests").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !request) {
          return res.status(404).json({ error: true, message: "Request not found or already completed/rejected" });
        }

        const requestId = String(id);

        // 2. Update the request status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("requests").update({ status: "Rejected" }).eq("id", requestId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update request status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Rejected Request Data",
            http_method: req.method,
            created_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Request has been rejected successfully" });
      }

      // Reject Quotation Endpoint
      case "rejectQuotation": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for rejectQuotation." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header" });
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

        // Get user roles from database
        const { data: userProfile, error: profileError } = await supabase.from("profiles").select("role").eq("id", user.id).single();

        if (profileError || !userProfile) {
          return res.status(403).json({
            error: true,
            message: "Unable to fetch user role or user not found",
          });
        }

        if (!userProfile.role) {
          return res.status(400).json({
            error: true,
            message: "User role is missing or null. Please update your role first.",
          });
        }

        // Convert role string to array, remove spaces, and lowercase
        const userRoles = userProfile.role.split(",").map((r) => r.trim().toLowerCase());

        const allowedRoles = ["procurement"];

        // Check if at least one role is allowed
        const hasAccess = userRoles.some((role) => allowedRoles.includes(role));

        if (!hasAccess) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Request ID" });
        }

        // 1. Get quotation with status "Pending"
        const { data: quotation, error: fetchError } = await supabase.from("quotations_purchases").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !quotation) {
          return res.status(404).json({ error: true, message: "Quotation not found or already completed/rejected" });
        }

        const quotationId = String(id);

        // 2. Update the quotation status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("quotations_purchases").update({ status: "Rejected" }).eq("id", quotationId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update quotation status: " + updateStatusError.message });
        }

        const { error: logErr } = await supabase.from("activity_logs").insert([
          {
            user_id: user.id,
            user_email: user.email,
            endpoint_name: "Rejected Quotation Data",
            http_method: req.method,
            created_at: new Date().toISOString(),
          },
        ]);

        if (logErr) {
          console.error("Failed to log activity:", logErr.message);
        }

        return res.status(201).json({ error: false, message: "Quotation has been rejected successfully" });
      }

      //   Get Overdue Endpoint
      case "getOverdue": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOverdue." });
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
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);

        // Fetch all invoices
        const { data: invoices, error: fetchError } = await supabase.from("invoices").select("grand_total, status, due_date");

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + fetchError.message });
        }

        // Calculate totals
        const unpaidTotal = invoices.filter((invoice) => invoice.status === "Unpaid").reduce((sum, invoice) => sum + (invoice.grand_total || 0), 0);

        const overdueCount = invoices.filter((invoice) => invoice.status === "Unpaid" && new Date(invoice.due_date) < today).length;

        const last30DaysTotal = invoices
          .filter((invoice) => {
            const dueDate = new Date(invoice.due_date);
            return dueDate >= thirtyDaysAgo && dueDate <= today;
          })
          .reduce((sum, invoice) => sum + (invoice.grand_total || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            unpaid_total: unpaidTotal,
            overdue_count: overdueCount,
            last_30_days_total: last30DaysTotal,
          },
        });
      }

      // Get Quotation Endpoint
      case "getQuotation": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getQuotation." });
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
        // const allowedRoles = ["sales", "marketing", "manager", "admin"];
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

        let query = supabase.from("quotations_purchases").select("*").order("quotation_date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["vendor_name", "status", "number"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

            const eqIntConditions = [];
            const eqFloatConditions = [];
            const dateConditions = [];

            // Search for grand_total (float)
            // Handle comma as decimal separator (e.g., "411639,88" or "411.639,88")
            let normalizedSearch = search.replace(/\./g, "").replace(/,/g, ".");
            if (!isNaN(normalizedSearch) && !Number.isNaN(parseFloat(normalizedSearch))) {
              eqFloatConditions.push("grand_total.eq." + parseFloat(normalizedSearch));
            }

            // Search for dates (quotation_date, start_date, valid_until)
            // Support various date formats: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, etc.
            const parseDateSearch = (searchStr) => {
              // Try to parse date from various formats
              let dateStr = searchStr.trim();

              // Format: YYYY-MM-DD or YYYY/MM/DD
              if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              // Format: DD-MM-YYYY or DD/MM/YYYY
              if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
              }

              // Format: partial date like "2024-01" or "01/2024"
              if (/^\d{4}[-/]\d{1,2}$/.test(dateStr)) {
                return dateStr.replace(/\//g, "-");
              }

              if (/^\d{1,2}[-/]\d{4}$/.test(dateStr)) {
                const parts = dateStr.split(/[-/]/);
                return `${parts[1]}-${parts[0].padStart(2, "0")}`;
              }

              return null;
            };

            const parsedDate = parseDateSearch(search);
            if (parsedDate) {
              // Check if it's a full date or partial (year-month)
              const isPartialDate = parsedDate.split("-").length === 2;

              if (isPartialDate) {
                // For partial dates (YYYY-MM), use ilike to match year-month
                dateConditions.push(`quotation_date.ilike.${parsedDate}%`);
                dateConditions.push(`start_date.ilike.${parsedDate}%`);
                dateConditions.push(`valid_until.ilike.${parsedDate}%`);
              } else {
                // For full dates, use exact match
                dateConditions.push(`quotation_date.eq.${parsedDate}`);
                dateConditions.push(`start_date.eq.${parsedDate}`);
                dateConditions.push(`valid_until.eq.${parsedDate}`);
              }
            }

            const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions, ...dateConditions].join(",");
            query = query.or(searchConditions);
          }
        }

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch quotation: " + error.message });

        const formattedData = data.map((sale) => ({
          ...sale,
          number: `${String(sale.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // =============================================================
      // >>>>>>>>>>>>>>>>>  OLD ENDPOINT  <<<<<<<<<<<<<
      // =============================================================

      // Add Invoice Endpoint
      case "addInvoice": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addInvoice." });
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
        // const allowedRoles = ["accounting", "finance", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { type, date, approver, due_date, status, tags, items, tax_method, ppn_percentage, pph_type, pph_percentage, grand_total } = req.body;

        if (!type || !date || !approver || !due_date || !status || !items || items.length === 0 || !ppn_percentage || !pph_type || !pph_percentage || !grand_total) {
          return res.status(400).json({
            error: true,
            message: "Missing required fields",
          });
        }

        const requestDate = new Date(date);
        const month = requestDate.getMonth() + 1; // 0-based
        const year = requestDate.getFullYear();

        // Generate prefix for this month: YYYYMM
        const prefix = `${year}${String(month).padStart(2, "0")}`;

        // Fetch latest invoice number
        const { data: latestInvoice, error: fetchError } = await supabase
          .from("invoices")
          .select("number")
          .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest invoice number: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (latestInvoice && latestInvoice.length > 0) {
          const lastNumber = latestInvoice[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }

        // Combine prefix + counter
        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        // Update items with total_per_item
        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const price = Number(item.price) || 0;
          const total_per_item = qty * price;

          return {
            ...item,
            total_per_item,
          };
        });

        const dpp = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // Calculate PPN and PPh
        const ppn = (dpp * (ppn_percentage || 0)) / 100;
        const pph = (dpp * (pph_percentage || 0)) / 100;

        // Final grand total
        // const grand_total = dpp + ppn - pph;

        const { error } = await supabase.from("invoices").insert([
          {
            user_id: user.id,
            type,
            date,
            number: nextNumber,
            approver,
            due_date,
            status,
            tags,
            items: updatedItems,
            tax_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            dpp,
            ppn,
            pph,
            grand_total,
          },
        ]);

        if (error) {
          return res.status(500).json({
            error: true,
            message: "Failed to create invoice: " + error.message,
          });
        }

        return res.status(201).json({
          error: false,
          message: "Invoice created successfully",
        });
      }

      // Add Offer Endpoint
      case "addOffer": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addOffer." });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { type, date, discount_terms, expiry_date, due_date, status, tags, items, grand_total } = req.body;

        if (!type || !date || !expiry_date || !due_date || !status || !items || items.length === 0 || !grand_total) {
          return res.status(400).json({
            error: true,
            message: "Missing required fields",
          });
        }

        const requestDate = new Date(date);
        const month = requestDate.getMonth() + 1; // 0-based
        const year = requestDate.getFullYear();

        // Generate prefix for this month: YYYYMM
        const prefix = `${year}${String(month).padStart(2, "0")}`;

        // Fetch latest offer number
        const { data: latestOffer, error: fetchError } = await supabase
          .from("offers")
          .select("number")
          .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest offer number: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (latestOffer && latestOffer.length > 0) {
          const lastNumber = latestOffer[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }

        // Combine prefix + counter
        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        // Final grand total
        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error } = await supabase.from("offers").insert([
          {
            user_id: user.id,
            type,
            date,
            number: nextNumber,
            discount_terms,
            expiry_date,
            due_date,
            status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
            items: updatedItems,
            grand_total,
          },
        ]);

        if (error) {
          return res.status(500).json({
            error: true,
            message: "Failed to create offer: " + error.message,
          });
        }

        return res.status(201).json({
          error: false,
          message: "Offer created successfully",
        });
      }

      // Add Order Endpoint
      case "addOrder": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addOrder." });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { type, date, orders_date, due_date, status, tags, items, grand_total } = req.body;

        if (!type || !date || !orders_date || !due_date || !status || !items || items.length === 0 || !grand_total) {
          return res.status(400).json({
            error: true,
            message: "Missing required fields",
          });
        }

        const requestDate = new Date(date);
        const month = requestDate.getMonth() + 1; // 0-based
        const year = requestDate.getFullYear();

        // Generate prefix for this month: YYYYMM
        const prefix = `${year}${String(month).padStart(2, "0")}`;

        // Fetch latest order number
        const { data: latestOrder, error: fetchError } = await supabase
          .from("orders")
          .select("number")
          .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest order number: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (latestOrder && latestOrder.length > 0) {
          const lastNumber = latestOrder[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }
        // Combine prefix + counter
        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        // Final grand total
        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error } = await supabase.from("orders").insert([
          {
            user_id: user.id,
            type,
            date,
            number: nextNumber,
            orders_date,
            due_date,
            status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
            items: updatedItems,
            grand_total,
          },
        ]);

        if (error) {
          return res.status(500).json({
            error: true,
            message: "Failed to create order: " + error.message,
          });
        }

        return res.status(201).json({
          error: false,
          message: "Order created successfully",
        });
      }

      // Add Request Endpoint
      case "addRequest": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addRequest." });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { type, date, requested_by, urgency, due_date, status, tags, items, grand_total } = req.body;

        if (!type || !date || !requested_by || !urgency || !due_date || !status || !items || items.length === 0 || !grand_total) {
          return res.status(400).json({
            error: true,
            message: "Missing required fields",
          });
        }

        const requestDate = new Date(date);
        const month = requestDate.getMonth() + 1; // 0-based
        const year = requestDate.getFullYear();

        // Generate prefix for this month: YYYYMM
        const prefix = `${year}${String(month).padStart(2, "0")}`;

        // Fetch latest request number for the same prefix
        const { data: latestRequests, error: fetchError } = await supabase
          .from("requests")
          .select("number")
          .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest request number: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (latestRequests && latestRequests.length > 0) {
          const lastNumber = latestRequests[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }

        // Combine prefix + counter
        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        // Final grand total
        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error } = await supabase.from("requests").insert([
          {
            user_id: user.id,
            type,
            date,
            number: nextNumber,
            requested_by,
            urgency,
            due_date,
            status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
            items: updatedItems,
            grand_total,
          },
        ]);

        if (error) {
          return res.status(500).json({
            error: true,
            message: "Failed to create request: " + error.message,
          });
        }

        return res.status(201).json({
          error: false,
          message: "Request created successfully",
        });
      }

      //   Add Shipment Endpoint
      case "addShipment": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addShipment." });
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
        // const allowedRoles = ["warehousing", "logistics", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { type, date, tracking_number, carrier, shipping_date, due_date, status, tags, items, grand_total } = req.body;

        if (!date || !items || items.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Missing required fields",
          });
        }

        const requestDate = new Date(date);
        const month = requestDate.getMonth() + 1; // 0-based
        const year = requestDate.getFullYear();

        // Generate prefix for this month: YYYYMM
        const prefix = `${year}${String(month).padStart(2, "0")}`;

        // Fetch latest shipment number
        const { data: latestShipment, error: fetchError } = await supabase
          .from("shipments")
          .select("number")
          .gte("date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest shipment number: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (latestShipment && latestShipment.length > 0) {
          const lastNumber = latestShipment[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }

        // Combine prefix + counter
        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        const updatedItems = items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          const total_per_item = qty * unit_price;

          return {
            ...item,
            total_per_item,
          };
        });

        // Final grand total
        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error } = await supabase.from("shipments").insert([
          {
            user_id: user.id,
            type,
            date,
            number: nextNumber,
            tracking_number,
            carrier,
            shipping_date,
            due_date,
            status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
            items: updatedItems,
            grand_total,
          },
        ]);

        if (error) {
          return res.status(500).json({
            error: true,
            message: "Failed to create shipment: " + error.message,
          });
        }

        return res.status(201).json({
          error: false,
          message: "Shipment created successfully",
        });
      }

      // Edit Invoice Endpoint
      case "editInvoice": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editInvoice." });
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
        // const allowedRoles = ["accounting", "finance", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, type, date, approver, due_date, status, tags, items, tax_method, ppn_percentage, pph_type, pph_percentage } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: "Invoice ID is required",
          });
        }

        // Check if invoice exists and belongs to user
        const { data: existingInvoice, error: fetchError } = await supabase.from("invoices").select("*").eq("id", id).single();

        if (fetchError || !existingInvoice) {
          return res.status(404).json({
            error: true,
            message: "Invoice not found or unauthorized",
          });
        }

        // Update items with total_per_item if items are provided
        let updatedItems = existingInvoice.items;
        if (items && items.length > 0) {
          updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const price = Number(item.price) || 0;
            const total_per_item = qty * price;

            return {
              ...item,
              total_per_item,
            };
          });
        }

        // Calculate totals
        const dpp = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);
        const ppn = (dpp * (ppn_percentage || existingInvoice.ppn_percentage || 0)) / 100;
        const pph = (dpp * (pph_percentage || existingInvoice.pph_percentage || 0)) / 100;
        const grand_total = dpp + ppn - pph;

        // Prepare update data
        const updateData = {
          user_id: user.id,
          type: type || existingInvoice.type,
          date: date || existingInvoice.date,
          approver: approver || existingInvoice.approver,
          due_date: due_date || existingInvoice.due_date,
          status: status || existingInvoice.status,
          tags: tags || existingInvoice.tags,
          items: updatedItems,
          tax_method: tax_method || existingInvoice.tax_method,
          ppn_percentage: ppn_percentage || existingInvoice.ppn_percentage,
          pph_type: pph_type || existingInvoice.pph_type,
          pph_percentage: pph_percentage || existingInvoice.pph_percentage,
          dpp,
          ppn,
          pph,
          grand_total,
          updated_at: new Date().toISOString(),
        };

        // Update invoice
        const { error: updateError } = await supabase.from("invoices").update(updateData).eq("id", id).eq("user_id", user.id);

        if (updateError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update invoice: " + updateError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Invoice updated successfully",
        });
      }

      // Edit Offer Endpoint
      case "editOffer": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editOffer." });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, type, date, discount_terms, expiry_date, due_date, status, tags, items } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: "Offer ID is required",
          });
        }

        // Check if offer exists and belongs to user
        const { data: existingOffer, error: fetchError } = await supabase.from("offers").select("*").eq("id", id).single();

        if (fetchError || !existingOffer) {
          return res.status(404).json({
            error: true,
            message: "Offer not found or unauthorized",
          });
        }

        // Update items with total_per_item if items are provided
        let updatedItems = existingOffer.items;
        if (items && items.length > 0) {
          updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const price = Number(item.price) || 0;
            const total_per_item = qty * price;

            return {
              qty,
              price,
              item_name: item.name || item.item_name,
              total_per_item,
            };
          });
        }

        // Calculate grand total
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // First, let's verify the update conditions
        const { data: verifyData, error: verifyError } = await supabase.from("offers").select("id").eq("id", id);

        if (verifyError) {
          return res.status(500).json({
            error: true,
            message: "Error verifying offer: " + verifyError.message,
          });
        }

        if (!verifyData || verifyData.length === 0) {
          return res.status(404).json({
            error: true,
            message: "Offer not found or unauthorized",
          });
        }

        // Prepare the update data
        const updateData = {
          user_id: user.id,
          type: type || existingOffer.type,
          date: date || existingOffer.date,
          discount_terms: discount_terms !== undefined ? discount_terms : existingOffer.discount_terms,
          expiry_date: expiry_date !== undefined ? expiry_date : existingOffer.expiry_date,
          due_date: due_date || existingOffer.due_date,
          status: status || existingOffer.status,
          tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingOffer.tags,
          items: updatedItems,
          grand_total,
          updated_at: new Date().toISOString(),
        };

        // Try the update with a different approach
        const { error: updateError } = await supabase.rpc("update_offer", {
          p_id: id,
          p_user_id: user.id,
          p_type: updateData.type,
          p_date: updateData.date,
          p_discount_terms: updateData.discount_terms,
          p_expiry_date: updateData.expiry_date,
          p_due_date: updateData.due_date,
          p_status: updateData.status,
          p_tags: updateData.tags,
          p_items: updateData.items,
          p_grand_total: updateData.grand_total,
          p_updated_at: updateData.updated_at,
        });

        if (updateError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update offer: " + updateError.message,
          });
        }

        // After update, fetch the updated record
        const { data: updatedOffer, error: fetchUpdatedError } = await supabase.from("offers").select("*").eq("id", id).single();

        if (fetchUpdatedError) {
          return res.status(500).json({
            error: true,
            message: "Error fetching updated offer: " + fetchUpdatedError.message,
          });
        }

        if (!updatedOffer) {
          return res.status(404).json({
            error: true,
            message: "Offer not found after update",
          });
        }

        return res.status(200).json({
          error: false,
          message: "Offer updated successfully",
          data: updatedOffer,
        });
      }

      // Edit Order Endpoint
      case "editOrder": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editOrder." });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, type, date, orders_date, due_date, status, tags, items } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: "Order ID is required",
          });
        }

        // Check if order exists and belongs to user
        const { data: existingOrder, error: fetchError } = await supabase.from("orders").select("*").eq("id", id).single();

        if (fetchError || !existingOrder) {
          return res.status(404).json({
            error: true,
            message: "Order not found or unauthorized",
          });
        }

        // Update items with total_per_item if items are provided
        let updatedItems = existingOrder.items;
        if (items && items.length > 0) {
          updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const price = Number(item.price) || 0;
            const total_per_item = qty * price;

            return {
              ...item,
              total_per_item,
            };
          });
        }

        // Calculate grand total
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // Prepare update data
        const updateData = {
          user_id: user.id,
          type: type || existingOrder.type,
          date: date || existingOrder.date,
          orders_date: orders_date || existingOrder.orders_date,
          due_date: due_date || existingOrder.due_date,
          status: status || existingOrder.status,
          tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingOrder.tags,
          items: updatedItems,
          grand_total,
          updated_at: new Date().toISOString(),
        };

        // Update order
        const { error: updateError } = await supabase.from("orders").update(updateData).eq("id", id).eq("user_id", user.id);

        if (updateError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update order: " + updateError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Order updated successfully",
        });
      }

      // Edit Request Endpoint
      case "editRequest": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editRequest." });
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
        // const allowedRoles = ["procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, type, date, requested_by, urgency, due_date, status, tags, items } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: "Request ID is required",
          });
        }

        // Check if request exists and belongs to user
        const { data: existingRequest, error: fetchError } = await supabase.from("requests").select("*").eq("id", id).single();

        if (fetchError || !existingRequest) {
          return res.status(404).json({
            error: true,
            message: "Request not found or unauthorized",
          });
        }

        // Update items with total_per_item if items are provided
        let updatedItems = existingRequest.items;
        if (items && items.length > 0) {
          updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const price = Number(item.price) || 0;
            const total_per_item = qty * price;

            return {
              ...item,
              total_per_item,
            };
          });
        }

        // Calculate grand total
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // Prepare update data
        const updateData = {
          user_id: user.id,
          type: type || existingRequest.type,
          date: date || existingRequest.date,
          requested_by: requested_by || existingRequest.requested_by,
          urgency: urgency || existingRequest.urgency,
          due_date: due_date || existingRequest.due_date,
          status: status || existingRequest.status,
          tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingRequest.tags,
          items: updatedItems,
          grand_total,
          updated_at: new Date().toISOString(),
        };

        // Update request
        const { error: updateError } = await supabase.from("requests").update(updateData).eq("id", id).eq("user_id", user.id);

        if (updateError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update request: " + updateError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Request updated successfully",
        });
      }

      // Edit Shipment Endpoint
      case "editShipment": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editShipment." });
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
        // const allowedRoles = ["warehousing", "logistics", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, type, date, tracking_number, carrier, shipping_date, due_date, status, tags, items } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: "Shipment ID is required",
          });
        }

        // Check if shipment exists and belongs to user
        const { data: existingShipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", id).single();

        if (fetchError || !existingShipment) {
          return res.status(404).json({
            error: true,
            message: "Shipment not found or unauthorized",
          });
        }

        // Update items with total_per_item if items are provided
        let updatedItems = existingShipment.items;
        if (items && items.length > 0) {
          updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const price = Number(item.price) || 0;
            const total_per_item = qty * price;

            return {
              ...item,
              total_per_item,
            };
          });
        }

        // Calculate grand total
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // Prepare update data
        const updateData = {
          user_id: user.id,
          type: type || existingShipment.type,
          date: date || existingShipment.date,
          tracking_number: tracking_number || existingShipment.tracking_number,
          carrier: carrier || existingShipment.carrier,
          shipping_date: shipping_date || existingShipment.shipping_date,
          due_date: due_date || existingShipment.due_date,
          status: status || existingShipment.status,
          tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingShipment.tags,
          items: updatedItems,
          grand_total,
          updated_at: new Date().toISOString(),
        };

        // Update shipment
        const { error: updateError } = await supabase.from("shipments").update(updateData).eq("id", id).eq("user_id", user.id);

        if (updateError) {
          return res.status(500).json({
            error: true,
            message: "Failed to update shipment: " + updateError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Shipment updated successfully",
        });
      }

      // Non-existent Endpoint
      default:
        return res.status(404).json({ error: true, message: "Endpoint not found" });
    }
  } catch (error) {
    return res.status(500).json({ error: true, message: error.message || "Unexpected server error" });
  }
};
