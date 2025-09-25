const { getSupabaseWithToken } = require("../lib/supabaseClient");
const Cors = require("cors");
const formidable = require("formidable");

// Initialization for middleware CORS
const cors = Cors({
  methods: ["GET", "POST", "OPTIONS", "PATCH", "PUT", "DELETE"],
  origin: ["http://localhost:8080", "http://192.168.100.3:8080", "https://prabaraja-webapp.vercel.app", "https://prabaraja-project-bkiqp6jqm-ivander-kendrick-wijonos-projects.vercel.app"],
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
      // =============================================================
      // >>>>>>>>>>>>>>>>>  NEW ENDPOINT FOR INPUT FILE  <<<<<<<<<<<<<
      // =============================================================

      // Add Billing Endpoint
      case "addNewBilling": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addBilling." });
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
          let { vendor_name, invoice_date, terms, grand_total, items: itemsRaw, payment_method, payment_COA, vendor_COA, type, number, status, memo } = req.body;

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

                const fileName = `purchasesBillings/${user.id}_${Date.now()}_${file.originalFilename}`;

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

          if (!vendor_name || !invoice_date || !terms || !grand_total || !itemsRaw || !payment_method || !payment_COA || !vendor_COA || !type || !number || !status || !memo) {
            return res.status(400).json({
              error: true,
              message: "Missing required fields",
            });
          }

          // Get all number columns from the table
          const { data: allNumbers, error: fetchError } = await supabase.from("billing_summary").select("number");

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

          const { error } = await supabase.from("billing_summary").insert([
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
              attachment_url: attachment_urls || null,
            },
          ]);

          if (error) {
            return res.status(500).json({
              error: true,
              message: "Failed to create billing summary: " + error.message,
            });
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
            number,
            date,
            approver,
            due_date,
            status,
            tags,
            items: itemsRaw,
            tax_calculation_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            grand_total,
            memo,
            vendor_name,
            vendor_address,
            vendor_phone,
            terms,
            freight_in,
            insurance,
            vendor_COA,
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

          if (!type || !date || !approver || !due_date || !status || !items || items.length === 0 || !ppn_percentage || !pph_type || !pph_percentage || !grand_total) {
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
              // number: nextNumber,
              number,
              approver,
              due_date,
              status,
              tags,
              items: updatedItems,
              tax_calculation_method,
              ppn_percentage,
              pph_type,
              pph_percentage,
              dpp,
              ppn,
              pph,
              grand_total,
              memo,
              attachment_url: attachment_urls || null,
              vendor_name,
              vendor_address,
              vendor_phone,
              terms,
              freight_in,
              insurance,
              vendor_COA,
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
          let { type, number, date, requested_by, urgency, due_date, status, tags, items: itemsRaw, grand_total, memo } = req.body;

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

          if (!type || !date || !requested_by || !urgency || !due_date || !status || !items || items.length === 0 || !grand_total) {
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
              // number: nextNumber,
              number,
              requested_by,
              urgency,
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
              message: "Failed to create request: " + error.message,
            });
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
          let { type, number, date, tracking_number, carrier, shipping_date, due_date, status, tags, items: itemsRaw, grand_total, memo } = req.body;

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

          if (!date || !items || items.length === 0) {
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
              // number: nextNumber,
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
              attachment_url: attachment_urls || null,
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
          let { type, number, vendor_name, quotation_date, valid_until, status, terms, items: itemsRaw, grand_total, total, memo, tax_details, due_date, tags, tax_method, dpp, ppn, pph, vendor_address, vendor_phone, start_date } = req.body;

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

          if (!vendor_name || !quotation_date || !valid_until || !status || !terms || !items || items.length === 0 || !grand_total || !total || !vendor_address || !vendor_phone || !start_date) {
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
            const unit_price = Number(item.unit_price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          const { error: insertError } = await supabase.from("quotations_purchases").insert([
            {
              user_id: user.id,
              // number: nextQuotationNumber,
              number,
              vendor_name,
              quotation_date,
              valid_until,
              status,
              terms,
              items: updatedItems,
              total,
              grand_total,
              memo,
              type,
              tax_details,
              due_date,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              tax_method,
              dpp,
              ppn,
              pph,
              vendor_address,
              vendor_phone,
              start_date,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (insertError)
            return res.status(500).json({
              error: true,
              message: "Failed to create quotation: " + insertError.message,
            });

          return res.status(201).json({ error: false, message: "Quotation created successfully" });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Billing Endpoint
      case "editNewBilling": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for editBilling." });
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
          const { id, vendor_name, invoice_date, terms, grand_total, items: itemsRaw, payment_method, payment_COA, vendor_COA, type, number, status, memo } = req.body;

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
                const fileName = `purchasesBillings/${user.id}_${Date.now()}_${file.originalFilename}`;

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
          const { data: existingBilling, error: fetchError } = await supabase.from("billing_summary").select("*").eq("id", id).single();

          if (fetchError || !existingBilling) {
            return res.status(404).json({
              error: true,
              message: "Billing not found or unauthorized",
            });
          }

          // Prepare update data
          const updateData = {
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
            attachment_url: newAttachmentUrls || null,
            updated_at: new Date().toISOString(),
          };

          // Update billing
          const { error: updateError } = await supabase.from("billing_summary").update(updateData).eq("id", id).eq("user_id", user.id);

          if (updateError) {
            return res.status(500).json({
              error: true,
              message: "Failed to update billing: " + updateError.message,
            });
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
            approver,
            due_date,
            status,
            tags,
            items: itemsRaw,
            tax_calculation_method,
            ppn_percentage,
            pph_type,
            pph_percentage,
            memo,
            filesToDelete,
            vendor_name,
            vendor_address,
            vendor_phone,
            terms,
            freight_in,
            insurance,
            vendor_COA,
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
            type: type || existingInvoice.type,
            date: date || existingInvoice.date,
            approver: approver || existingInvoice.approver,
            due_date: due_date || existingInvoice.due_date,
            status: status || existingInvoice.status,
            tags: tags || existingInvoice.tags,
            items: updatedItems,
            tax_calculation_method: tax_calculation_method || existingInvoice.tax_calculation_method,
            ppn_percentage: ppn_percentage || existingInvoice.ppn_percentage,
            pph_type: pph_type || existingInvoice.pph_type,
            pph_percentage: pph_percentage || existingInvoice.pph_percentage,
            dpp,
            ppn,
            pph,
            grand_total,
            memo,
            attachment_url: newAttachmentUrls || null,
            vendor_name,
            vendor_address,
            vendor_phone,
            terms,
            freight_in,
            insurance,
            vendor_COA,
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
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Offer Endpoint
      case "editNewOffer": {
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
          const { id, type, date, requested_by, urgency, due_date, status, tags, items: itemsRaw, memo, filesToDelete } = req.body;

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
            type: type || existingRequest.type,
            date: date || existingRequest.date,
            requested_by: requested_by || existingRequest.requested_by,
            urgency: urgency || existingRequest.urgency,
            due_date: due_date || existingRequest.due_date,
            status: status || existingRequest.status,
            tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingRequest.tags,
            items: updatedItems,
            grand_total,
            memo,
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
          const { id, type, date, tracking_number, carrier, shipping_date, due_date, status, tags, items: itemsRaw, memo, filesToDelete } = req.body;

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
          const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

          // Prepare update data
          const updateData = {
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
            memo,
            attachment_url: newAttachmentUrls || null,
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
            type,
            vendor_name,
            quotation_date,
            valid_until,
            status,
            terms,
            items: itemsRaw,
            grand_total,
            memo,
            tax_details,
            due_date,
            tags,
            tax_method,
            dpp,
            ppn,
            pph,
            vendor_address,
            vendor_phone,
            start_date,
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
            .from("quotations_purchases")
            .update({
              quotation_date,
              valid_until,
              status,
              terms,
              items: updatedItems,
              // total,
              memo,
              type,
              tax_details,
              attachment_url: newAttachmentUrls || null,
              updated_at: new Date().toISOString(),
              vendor_name,
              grand_total,
              due_date,
              tags: tags ? tags.split(",").map((tag) => tag.trim()) : [],
              tax_method,
              dpp,
              ppn,
              pph,
              vendor_address,
              vendor_phone,
              start_date,
            })
            .eq("id", id);

          if (updateError) {
            return res.status(500).json({ error: true, message: "Failed to update quotation: " + updateError.message });
          }

          return res.status(200).json({ error: false, message: "Quotation updated successfully" });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Delete Billing Summary, Invoice, Shipment, Order, Offer, and Request Endpoint
      case "deleteBilling":
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
          deleteBilling: "billing_summary",
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

        const { data: item, error: fetchError } = await supabase.from(table).select("id").eq("id", id);

        if (fetchError || !item || item.length === 0) {
          return res.status(404).json({
            error: true,
            message: `${action.replace("delete", "")} not found or unauthorized`,
          });
        }

        const { error: deleteError } = await supabase.from(table).delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({
            error: true,
            message: `Failed to delete data: ${deleteError.message}`,
          });
        }

        return res.status(200).json({
          error: false,
          message: `${action} deleted successfully`,
        });
      }

      // Get Billing Endpoint
      case "getBilling": {
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

        let query = supabase.from("billing_summary").select("*").order("invoice_date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["vendor_name"];
          const numericColumns = ["grand_total"];

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

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch billing summary: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${"BIL"}-${String(item.number).padStart(5, "0")}`,
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
          const stringColumns = ["approver", "id"];
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

            const codeMatch = search.match(/^INV-?0*(\d{5,})$/i);
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
          const stringColumns = ["tracking_number", "carrier"];
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

            const codeMatch = search.match(/^SH-?0*(\d{5,})$/i);
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
          const numericColumns = ["grand_total"];
          const uuidColumns = ["id"];

          if (uuidColumns.includes("id") && isUUID(search)) {
            query = query.eq("id", search);
          } else {
            const eqIntConditions = [];
            const eqFloatConditions = [];

            if (!isNaN(search) && Number.isInteger(Number(search))) {
              eqIntConditions.push("number.eq." + Number(search));
            }

            if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
              const value = parseFloat(search);
              eqFloatConditions.push(...numericColumns.map((col) => `${col}.eq.${value}`));
            }

            const codeMatch = search.match(/^ORD-?0*(\d{5,})$/i);
            if (codeMatch) {
              const extractedNumber = parseInt(codeMatch[1], 10);
              if (!isNaN(extractedNumber)) {
                eqIntConditions.push("number.eq." + extractedNumber);
              }
            }

            const searchConditions = [...eqIntConditions, ...eqFloatConditions].join(",");
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
          const stringColumns = ["discount_terms"];
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

            const codeMatch = search.match(/^OFR-?0*(\d{5,})$/i);
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
          const stringColumns = ["requested_by", "urgency"];
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

            const codeMatch = search.match(/^REQ-?0*(\d{5,})$/i);
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

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch requests: " + error.message });

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
          number: `${"INV"}-${String(item.number).padStart(5, "0")}`,
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

        let query = supabase.from("shipments").select("*").eq("status", "Pending");
        query = query.order("date", { ascending: false }).limit(limit);

        const { data, error } = await query;

        if (error) {
          return res.status(500).json({ error: true, message: `Failed to fetch approval data: " + ${error.message}` });
        }

        const formattedData = data.map((item) => ({
          ...item,
          number: `${"SH"}-${String(item.number).padStart(5, "0")}`,
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
          number: `${"REQ"}-${String(item.number).padStart(5, "0")}`,
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
          number: `${"QUO"}-${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Approval Billing Payment Invoices Endpoint
      case "sendBillingToCOA": {
        if (method !== "POST") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for sendBillingToCOA.",
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

        const { data: billing, error: billingError } = await supabase
          .from("billing_summary")
          .select("items, grand_total, due_date, payment_method, payment_date, payment_COA, vendor_name, vendor_COA, terms, number")
          .eq("id", id)
          .ilike("status", "pending")
          .single();

        if (billingError || !billing) {
          return res.status(404).json({ error: true, message: "Billing not found or already completed/cancelled" });
        }

        const { items, grand_total, due_date, payment_method, payment_date, payment_COA, vendor_name, vendor_COA, terms, number } = billing;

        // Buat journal entry utama
        const { data: journal, error: journalError } = await supabase
          .from("journal_entries")
          .insert({
            id: billingId,
            invoice_number: `INV-${number}`,
            description: `Journal for Billing ${billingId}`,
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

        // ====== Initialize Journal Line Entries and Totals ======
        const lineEntries = [];
        let totalInventory = 0;

        let discountPayment = 0;
        // let penaltyPayment = 0;
        let alerts = []; // Store alert messages for user

        // ====== Global Discount / Penalty Calculation ======
        if (terms) {
          // Example: "2/10, n/30"
          const match = billing.terms.match(/(\d+)\/(\d+),\s*n\/(\d+)/);
          if (match) {
            const discountRate = parseFloat(match[1]); // e.g., 2 (%)
            const discountDays = parseInt(match[2], 10); // e.g., 10 (discount days)
            const netDays = parseInt(match[3], 10); // e.g., 30 (final due days)

            const paymentDateObj = new Date(payment_date);
            const dueDateObj = new Date(due_date);
            const invoiceDateObj = new Date(billing.invoice_date);

            const diffDiscountDays = Math.ceil((paymentDateObj - invoiceDateObj) / (1000 * 60 * 60 * 24));
            const diffDueDays = Math.ceil((dueDateObj - paymentDateObj) / (1000 * 60 * 60 * 24));

            // ====== Discount eligibility ======
            if (diffDiscountDays <= discountDays) {
              discountPayment = (grand_total * discountRate) / 100;
              alerts.push(`You are eligible for a ${discountRate}% discount. ${discountDays - diffDiscountDays} days left to claim it.`);
            } else if (paymentDateObj > dueDateObj) {
              // Example penalty = 5%
              // penaltyPayment = (grand_total * 5) / 100;
              alerts.push("Warning: Payment is past due date. Penalty may apply.");
            }

            // ====== General due date alert ======
            if (diffDueDays > 0) {
              alerts.push(`You have ${diffDueDays} days left before the due date (n/${netDays}).`);
            } else {
              alerts.push("Invoice is already overdue!");
            }
          }
        }

        // ====== Prepaid Installment Alerts ======
        if (prepaid_count) {
          if (prepaid_count === 3) {
            alerts.push("Installment 1: Check remaining days for discount eligibility.");
            alerts.push("Installment 3: Check remaining days for discount eligibility.");
          } else if (prepaid_count === 2) {
            alerts.push("Installment 1: Check remaining days for discount eligibility.");
          }
        }

        // ====== Total Qty Calculation (for proportional discount/penalty allocation) ======
        const totalQty = items.reduce((sum, i) => sum + i.qty, 0);

        // ====== Loop Items (allocate discount proportionally to inventory) ======
        for (const item of items) {
          const { coa, qty } = item;
          const itemDiscount = discountPayment > 0 ? (discountPayment / totalQty) * qty : 0;
          totalInventory += itemDiscount;
        }

        // ====== Journal Entries: Full Payment ======
        if (payment_method === "Full Payment") {
          // Debit Vendor
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: vendor_COA,
            description: vendor_name,
            debit: grand_total,
            credit: 0,
            user_id: user.id,
          });

          // Credit Cash & Bank
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: payment_COA,
            description: "Cash & Bank",
            debit: 0,
            credit: grand_total,
            user_id: user.id,
          });
        }

        // ====== Journal Entries: Partial Payment ======
        else if (payment_method === "Partial Payment") {
          // Example: partialAmount is the actual paid amount
          const partialAmount = paid_amount || 0;

          if (partialAmount > 0) {
            // Debit Vendor
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: vendor_COA,
              description: `${vendor_name} (Partial Payment)`,
              debit: partialAmount,
              credit: 0,
              user_id: user.id,
            });

            // Credit Cash & Bank
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: payment_COA,
              description: "Cash & Bank (Partial Payment)",
              debit: 0,
              credit: partialAmount,
              user_id: user.id,
            });

            alerts.push(`Partial payment of ${partialAmount} has been recorded. Remaining balance = ${grand_total - partialAmount}.`);
          } else {
            alerts.push("Warning: Partial payment amount is missing or zero.");
          }
        }

        // ====== Journal Entries: Discount Payment Allocation ======
        if (discountPayment > 0) {
          // Debit Cash & Bank
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: payment_COA,
            description: "Cash & Bank (Discount Allocation)",
            debit: discountPayment,
            credit: 0,
            user_id: user.id,
          });

          // Credit allocation to Inventory (proportional per item)
          for (const item of items) {
            const itemDisc = (discountPayment / totalQty) * item.qty;
            lineEntries.push({
              journal_entry_id: journal.id,
              account_code: item.coa,
              description: `Inventory - ${item.item_name} (Discount Allocation)`,
              debit: 0,
              credit: itemDisc,
              user_id: user.id,
            });
          }
        }

        // ====== Kalau ada Penalty ======
        // if (penaltyPayment > 0) {
        //   // Debit alokasi ke setiap Inventory item
        //   for (const item of items) {
        //     const itemPen = (penaltyPayment / totalQty) * item.qty;
        //     lineEntries.push({
        //       journal_entry_id: journal.id,
        //       account_code: item.coa,
        //       description: `Penalty Allocation - ${item.item_name}`,
        //       debit: itemPen,
        //       credit: 0,
        //       user_id: user.id,
        //     });
        //   }

        //   // Kredit ke Cash & Bank
        //   lineEntries.push({
        //     journal_entry_id: journal.id,
        //     account_code: payment_COA,
        //     description: "Cash & Bank (Penalty)",
        //     debit: 0,
        //     credit: penaltyPayment,
        //     user_id: user.id,
        //   });
        // }

        // Insert ke Supabase
        const { error: insertError } = await supabase.from("journal_entry_lines").insert(lineEntries);

        if (insertError) {
          return res.status(500).json({
            error: true,
            message: "Failed to insert journal lines: " + insertError.message,
          });
        }

        // const { data: current, error: fetchError } = await supabase.from("billing_summary").select("grand_total").eq("id", billingId).single();

        // if (fetchError) throw fetchError;

        // const newGrandTotal = current.grand_total - discountPayment;

        // const { data, error } = await supabase
        //   .from("billing_summary")
        //   .update({
        //     status: "Completed",
        //     grand_total: newGrandTotal,
        //   })
        //   .eq("id", billingId)
        //   .select();

        return res.status(201).json({
          error: false,
          message: "Journal Entries created successfully",
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
        const { data: invoice, error: invoiceError } = await supabase.from("invoices").select("items, freight_in, insurance, ppn, ppn_percentage, vendor_COA, vendor_name, number").eq("id", id).ilike("status", "pending").single();

        if (invoiceError || !invoice) {
          return res.status(404).json({ error: true, message: "Invoice not found or already completed/cancelled" });
        }

        const { items, freight_in, insurance, ppn, ppn_percentage, vendor_COA, vendor_name, number } = invoice;

        // 2. Hitung total qty semua item
        const totalQty = items.reduce((sum, i) => sum + i.qty, 0);
        console.log(totalQty);

        const freightShare = totalQty > 0 ? freight_in / totalQty : 0;
        const insuranceShare = totalQty > 0 ? insurance / totalQty : 0;

        // 3. Buat Journal Entry
        const { data: journal, error: journalError } = await supabase
          .from("journal_entries")
          .insert([
            {
              entry_date: new Date().toISOString().split("T")[0],
              description: `Create Journal Entries for Purchase with ID = ${id}`,
              invoice_number: number,
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
        const lineEntries = [];
        let totalInventory = 0;

        for (const item of items) {
          const { coa, qty, price, returnVal, disc_item, disc_item_type, item_name } = item;

          // Hitung gross & diskon per item
          let discountedPrice;
          let gross;

          if (disc_item_type === "percentage") {
            discountedPrice = price - (price * disc_item) / 100;
            gross = (discountedPrice + freightShare + insuranceShare) * qty;
          } else if (disc_item_type === "rupiah") {
            gross = (price + freightShare + insuranceShare) * qty - disc_item;
          }

          // Hitung net
          // const net = gross - discount + penalty - (returnVal || 0);
          const net = gross - (returnVal || 0);

          totalInventory += net;

          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: coa, // langsung ambil dari item.coa
            description: `Inventory - ${item_name}`, // dari item_name JSON
            debit: net,
            credit: 0,
            user_id: user.id,
            invoice_number: number,
          });
        }

        // 5. VAT In
        if (ppn > 0) {
          lineEntries.push({
            journal_entry_id: journal.id,
            account_code: "150101", // VAT In COA
            description: "VAT In",
            debit: ppn,
            credit: 0,
            user_id: user.id,
            invoice_number: number,
          });
        }

        // 6. Kredit: AP - Vendor
        const totalDebit = totalInventory + (ppn || 0);
        lineEntries.push({
          journal_entry_id: journal.id,
          account_code: vendor_COA, // mapping ke COA vendor
          description: vendor_name,
          debit: 0,
          credit: totalDebit,
          user_id: user.id,
          invoice_number: number,
        });

        // 7. Insert journal lines
        const { error: insertError } = await supabase.from("journal_entry_lines").insert(lineEntries);

        if (insertError) {
          return res.status(500).json({
            error: true,
            message: "Failed to insert journal lines: " + insertError.message,
          });
        }

        const { data: updated, error: updateStatusError } = await supabase.from("invoices").update({ status: "Completed" }).eq("id", invoiceId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update invoice status: " + updateStatusError.message });
        }

        return res.status(201).json({
          error: false,
          message: "Journal Entries created successfully",
          data: {
            journal,
            lines: lineEntries,
          },
        });
      }

      // Approval Shipment Endpoint
      case "sendShipmentToInvoice": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sendShipmentToInvoice." });
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
        const { data: shipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !shipment) {
          return res.status(404).json({ error: true, message: "Shipment not found or already completed/cancelled" });
        }

        const shipmentId = String(id);

        // 2. Update the shipment status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("shipments").update({ status: "Completed" }).eq("id", shipmentId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update shipment status: " + updateStatusError.message });
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

        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // 5. Insert to invoices
        const { error: insertError } = await supabase.from("invoices").insert([
          {
            user_id: user.id,
            type: "Invoice",
            date: shipment.date,
            // number: nextNumber,
            number: shipment.number,
            approver: "",
            due_date: shipment.due_date,
            status: "Pending",
            tax_calculation_method: true,
            tags: shipment.tags,
            items: updatedItems,
            grand_total: shipment.grand_total,
            memo: shipment.memo,
            attachment_url: shipment.attachment_url,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert invoice: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Invoice created from shipment successfully" });
      }

      // Approval Shipment Endpoint
      case "sendShipmentToInvoice": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sendShipmentToInvoice." });
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
        const { data: shipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !shipment) {
          return res.status(404).json({ error: true, message: "Shipment not found or already completed/cancelled" });
        }

        const shipmentId = String(id);

        // 2. Update the shipment status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("shipments").update({ status: "Completed" }).eq("id", shipmentId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update shipment status: " + updateStatusError.message });
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

        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // 5. Insert to invoices
        const { error: insertError } = await supabase.from("invoices").insert([
          {
            user_id: user.id,
            type: "Invoice",
            date: shipment.date,
            // number: nextNumber,
            number: shipment.number,
            approver: "",
            due_date: shipment.due_date,
            status: "Pending",
            tax_calculation_method: true,
            tags: shipment.tags,
            items: updatedItems,
            grand_total: shipment.grand_total,
            memo: shipment.memo,
            attachment_url: shipment.attachment_url,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert invoice: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Invoice created from shipment successfully" });
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

        // 1. Get request with status "Pending"
        const { data: request, error: fetchError } = await supabase.from("requests").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !request) {
          return res.status(404).json({ error: true, message: "Request not found or already completed/cancelled" });
        }

        const requestId = String(id);

        // 2. Update the request status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("requests").update({ status: "Completed" }).eq("id", requestId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update request status: " + updateStatusError.message });
        }

        // 3. Generate new order number (similar with addNewOrder endpoint)
        const requestDate = new Date(request.date);
        const requestMonth = requestDate.getMonth() + 1;
        const requestYear = requestDate.getFullYear();
        const prefix = `${requestYear}${String(requestMonth).padStart(2, "0")}`;
        const prefixInt = parseInt(prefix + "0", 10);
        const nextPrefixInt = parseInt(prefix + "9999", 10);

        const { data: latestOrder, error: orderError } = await supabase.from("orders").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        if (orderError) {
          return res.status(500).json({
            error: true,
            message: "Failed to create order from request: " + orderError.message,
          });
        }

        let counter = 1;
        if (latestOrder && latestOrder.length > 0) {
          const lastNumber = latestOrder[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
          counter = lastCounter + 1;
        }

        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        // 4. Calculate again the grand total (optional)
        const updatedItems = request.items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          return {
            ...item,
            total_per_item: qty * unit_price,
          };
        });

        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // 5. Insert to orders
        const { error: insertError } = await supabase.from("orders").insert([
          {
            user_id: user.id,
            type: "Order",
            date: request.date,
            // number: nextNumber,
            number: request.number,
            orders_date: request.date,
            due_date: request.due_date,
            status: "Pending",
            tags: request.tags,
            items: updatedItems,
            grand_total: request.grand_total,
            memo: request.memo,
            attachment_url: request.attachment_url,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert order: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Order created from request successfully" });
      }

      // Approval Offer Endpoint
      case "sendOfferToRequest": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sendOfferToRequest." });
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

        // Check if the user role is among those permitted
        const allowedRoles = ["procurement"];
        if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
          return res.status(403).json({
            error: true,
            message: "Access denied. You are not authorized to perform this action.",
          });
        }

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Request ID" });
        }

        // 1. Get offer with status "Pending"
        const { data: offer, error: fetchError } = await supabase.from("offers").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !offer) {
          return res.status(404).json({ error: true, message: "Offer not found or already completed/cancelled" });
        }

        const offerId = String(id);

        // 2. Update the offer status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("offers").update({ status: "Completed" }).eq("id", offerId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update offer status: " + updateStatusError.message });
        }

        // 3. Generate new request number (similar with addNewRequest endpoint)
        const offerDate = new Date(offer.date);
        const offerMonth = offerDate.getMonth() + 1;
        const offerYear = offerDate.getFullYear();
        const prefix = `${offerYear}${String(offerMonth).padStart(2, "0")}`;
        const prefixInt = parseInt(prefix + "0", 10);
        const nextPrefixInt = parseInt(prefix + "9999", 10);

        const { data: latestRequest, error: requestError } = await supabase.from("requests").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        if (requestError) {
          return res.status(500).json({
            error: true,
            message: "Failed to create request from offer: " + requestError.message,
          });
        }

        let counter = 1;
        if (latestRequest && latestRequest.length > 0) {
          const lastNumber = latestRequest[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(prefix.length), 10);
          counter = lastCounter + 1;
        }

        const nextNumber = parseInt(`${prefix}${counter}`, 10);

        // 4. Calculate again the grand total (optional)
        const updatedItems = offer.items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          return {
            ...item,
            total_per_item: qty * unit_price,
          };
        });

        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // 5. Insert to requests
        const { error: insertError } = await supabase.from("requests").insert([
          {
            user_id: user.id,
            type: "Request",
            date: offer.date,
            number: nextNumber,
            requested_by: "",
            urgency: "Low",
            due_date: offer.due_date,
            status: "Pending",
            tags: offer.tags,
            items: updatedItems,
            grand_total: offer.grand_total,
            memo: offer.memo,
            attachment_url: offer.attachment_url,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert request: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Request created from offer successfully" });
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

        // 1. Get quotation with status "Pending"
        const { data: quotation, error: fetchError } = await supabase.from("quotations_purchases").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !quotation) {
          return res.status(404).json({ error: true, message: "Quotation not found or already completed/cancelled" });
        }

        const quotationId = String(id);

        // 2. Update the quotation status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("quotations_purchases").update({ status: "Completed" }).eq("id", quotationId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update quotation status: " + updateStatusError.message });
        }

        // // 3. Generate new offer number (similar with addNewOffer endpoint)
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

        // 4. Calculate again the grand total (optional)
        const updatedItems = quotation.items.map((item) => {
          const qty = Number(item.qty) || 0;
          const unit_price = Number(item.price) || 0;
          return {
            ...item,
            total_per_item: qty * unit_price,
          };
        });

        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        // 5. Insert to offers
        const { error: insertError } = await supabase.from("offers").insert([
          {
            user_id: user.id,
            type: "Offer",
            date: quotation.quotation_date,
            // number: nextNumber,
            number: quotation.number,
            discount_terms: null,
            expiry_date: null,
            due_date: quotation.due_date,
            status: "Pending",
            tags: quotation.tags,
            items: updatedItems,
            grand_total: quotation.grand_total,
            memo: quotation.memo,
            attachment_url: quotation.attachment_url,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert offer: " + insertError.message });
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
        const { data: billing, error: fetchError } = await supabase.from("billing_summary").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !billing) {
          return res.status(404).json({ error: true, message: "Billing not found or already completed/cancelled" });
        }

        const billingId = String(id);

        // 2. Update the billing status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("billing_summary").update({ status: "Rejected" }).eq("id", billingId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update billing status: " + updateStatusError.message });
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
          return res.status(404).json({ error: true, message: "Invoice not found or already completed/cancelled" });
        }

        const invoiceId = String(id);

        // 2. Update the invoice status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("invoices").update({ status: "Rejected" }).eq("id", invoiceId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update invoice status: " + updateStatusError.message });
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
        const { data: shipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", id).ilike("status", "pending").single();

        if (fetchError || !shipment) {
          return res.status(404).json({ error: true, message: "Shipment not found or already completed/cancelled" });
        }

        const shipmentId = String(id);

        // 2. Update the shipment status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("shipments").update({ status: "Rejected" }).eq("id", shipmentId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update shipment status: " + updateStatusError.message });
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
          return res.status(404).json({ error: true, message: "Request not found or already completed/cancelled" });
        }

        const requestId = String(id);

        // 2. Update the request status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("requests").update({ status: "Rejected" }).eq("id", requestId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update request status: " + updateStatusError.message });
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
          return res.status(404).json({ error: true, message: "Quotation not found or already completed/cancelled" });
        }

        const quotationId = String(id);

        // 2. Update the quotation status to "Completed"
        const { data: updated, error: updateStatusError } = await supabase.from("quotations_purchases").update({ status: "Rejected" }).eq("id", quotationId).select();

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update quotation status: " + updateStatusError.message });
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
          const stringColumns = ["vendor_name"];
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
              eqFloatConditions.push("grand_total.eq." + parseFloat(search));
            }

            // For detect search like "Quotation #00588"
            const codeMatch = search.match(/^quotation\s?#?0*(\d{7,})$/i);
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

        const { type, date, approver, due_date, status, tags, items, tax_calculation_method, ppn_percentage, pph_type, pph_percentage, grand_total } = req.body;

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
            tax_calculation_method,
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

        const { id, type, date, approver, due_date, status, tags, items, tax_calculation_method, ppn_percentage, pph_type, pph_percentage } = req.body;

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
          type: type || existingInvoice.type,
          date: date || existingInvoice.date,
          approver: approver || existingInvoice.approver,
          due_date: due_date || existingInvoice.due_date,
          status: status || existingInvoice.status,
          tags: tags || existingInvoice.tags,
          items: updatedItems,
          tax_calculation_method: tax_calculation_method || existingInvoice.tax_calculation_method,
          ppn_percentage: ppn_percentage || existingInvoice.ppn_percentage,
          pph_type: pph_type || existingInvoice.pph_type,
          pph_percentage: pph_percentage || existingInvoice.pph_percentage,
          dpp,
          ppn,
          pph,
          grand_total,
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
          type: type || existingOrder.type,
          date: date || existingOrder.date,
          orders_date: orders_date || existingOrder.orders_date,
          due_date: due_date || existingOrder.due_date,
          status: status || existingOrder.status,
          tags: tags ? tags.split(",").map((tag) => tag.trim()) : existingOrder.tags,
          items: updatedItems,
          grand_total,
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

      // =============================================================
      // >>>>>>>>>>>>>>>>>  EXAMPLE FOR FLUENTREPORT  <<<<<<<<<<<<<
      // =============================================================

      // //   Get Invoice Report Endpoint
      // case "getInvoiceReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getInvoiceReport." });
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

      //   const invoiceId = req.query.id;
      //   if (!invoiceId) return res.status(400).json({ error: true, message: "Missing invoice id" });

      //   const { data: invoice, error: fetchError } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();

      //   if (fetchError || !invoice) {
      //     return res.status(404).json({ error: true, message: "Invoice not found" });
      //   }

      //   // Format invoice number with proper prefix and padding
      //   const formattedInvoiceNumber = `INV-${String(invoice.number).padStart(5, "0")}`;

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      //     return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
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
      //     // Invoice Summary Section
      //     rpt.print("Invoice Summary", { x: 40, y: 40, fontSize: 20, bold: true });

      //     // Status badge (top right)
      //     if (invoice.status === "Completed" || invoice.status === "Paid") {
      //       rpt.print("PAID", { x: 500, y: 40, fontSize: 12, color: "green" });
      //     }

      //     // Invoice details grid
      //     rpt.print("Invoice Number", { x: 40, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formattedInvoiceNumber, { x: 40, y: 95, fontSize: 12 });

      //     rpt.print("Invoice Date", { x: 250, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(invoice.date), { x: 250, y: 95, fontSize: 12 });

      //     rpt.print("Due Date", { x: 460, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(invoice.due_date), { x: 460, y: 95, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 120, y2: 120 });

      //     // Vendor Information Section
      //     rpt.print("Vendor Information", { x: 40, y: 140, fontSize: 20, bold: true });

      //     rpt.print("Vendor Name", { x: 40, y: 170, fontSize: 10, color: "gray" });
      //     rpt.print("Global Supplies Co.", { x: 40, y: 185, fontSize: 12 });

      //     rpt.print("Vendor ID", { x: 40, y: 210, fontSize: 10, color: "gray" });
      //     rpt.print("V-2779", { x: 40, y: 225, fontSize: 12 });

      //     rpt.print("Contact Information", { x: 40, y: 250, fontSize: 10, color: "gray" });
      //     rpt.print("accounts@globalsupplies.com", { x: 40, y: 265, fontSize: 12 });
      //     rpt.print("+1 (555) 987-6543", { x: 40, y: 280, fontSize: 12 });

      //     rpt.print("Address", { x: 40, y: 305, fontSize: 10, color: "gray" });
      //     rpt.print("1234 Vendor Street", { x: 40, y: 320, fontSize: 12 });
      //     rpt.print("Supplier City, SC 54321", { x: 40, y: 335, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 365, y2: 365 });

      //     // Invoice Items Section
      //     rpt.print("Invoice Items", { x: 40, y: 385, fontSize: 20, bold: true });

      //     // Items table header
      //     rpt.print("Item", { x: 40, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 250, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Unit Price", { x: 380, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Total", { x: 510, y: 415, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: 435, y2: 435 });
      //   });

      //   // Detail rows
      //   let currentY = 445;
      //   const pageHeightLimit = 780;
      //   report.detail((rpt, data) => {
      //     if (currentY > pageHeightLimit) {
      //       rpt.newPage(); // Pindah ke halaman baru
      //       currentY = 40; // Reset posisi Y di halaman baru (sesuai margin top)
      //     }
      //     rpt.print(data.name, { x: 40, y: currentY, fontSize: 12 });
      //     rpt.print(data.qty.toString(), { x: 250, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.price), { x: 380, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.total_per_item), { x: 510, y: currentY, fontSize: 12 });

      //     currentY += 25;
      //   });

      //   // Set data source
      //   report.data(invoice.items);

      //   // Footer with totals
      //   report.finalSummary((rpt) => {
      //     // Totals section - start right after the last item
      //     const startY = currentY + 55;

      //     // Totals section
      //     rpt.print("Subtotal", { x: 380, y: startY, fontSize: 12 });
      //     rpt.print(formatCurrency(invoice.dpp), { x: 510, y: startY, fontSize: 12 });

      //     rpt.print(`Tax (${invoice.ppn_percentage}%)`, { x: 380, y: startY + 25, fontSize: 12 });
      //     rpt.print(formatCurrency(invoice.ppn), { x: 510, y: startY + 25, fontSize: 12 });

      //     rpt.print("Total", { x: 380, y: startY + 50, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(invoice.grand_total), { x: 510, y: startY + 50, fontSize: 12, bold: true });

      //     rpt.print("Balance Due", { x: 380, y: startY + 75, fontSize: 12 });
      //     rpt.print(formatCurrency(0), { x: 510, y: startY + 75, fontSize: 12, color: "green" });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: startY + 50, y2: startY + 50 });

      //     // Payment Information Section
      //     rpt.print("Payment Information", { x: 40, y: startY + 120, fontSize: 20, bold: true });

      //     rpt.print("Payment Terms", { x: 40, y: startY + 150, fontSize: 10, color: "gray" });
      //     rpt.print("Net 30", { x: 40, y: startY + 165, fontSize: 12 });

      //     rpt.print("Payment Method", { x: 40, y: startY + 190, fontSize: 10, color: "gray" });
      //     rpt.print("Bank Transfer", { x: 40, y: startY + 205, fontSize: 12 });

      //     rpt.print("Bank Account", { x: 40, y: startY + 230, fontSize: 10, color: "gray" });
      //     rpt.print("Global Supplies Bank Account", { x: 40, y: startY + 245, fontSize: 12 });
      //     rpt.print("Account #: XXXX-XXXX-1234", { x: 40, y: startY + 260, fontSize: 12 });

      //     rpt.print("Payment Status", { x: 40, y: startY + 285, fontSize: 10, color: "gray" });
      //     rpt.print("Paid", { x: 40, y: startY + 300, fontSize: 12, color: "green" });
      //     rpt.print("Paid on Jun 5, 2025", { x: 40, y: startY + 315, fontSize: 12 });
      //   });

      //   // Render the report
      //   report.render((err) => {
      //     if (err) {
      //       return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
      //     }
      //   });

      //   // Set response headers and pipe the PDF stream
      //   res.setHeader("Content-Type", "application/pdf");
      //   res.setHeader("Content-Disposition", `inline; filename=${formattedInvoiceNumber}.pdf`);
      //   pdfStream.pipe(res);

      //   break;
      // }

      // //   Get Shipment Report Endpoint
      // case "getShipmentReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getShipmentReport." });
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

      //   const shipmentId = req.query.id;
      //   if (!shipmentId) return res.status(400).json({ error: true, message: "Missing shipment id" });

      //   const { data: shipment, error: fetchError } = await supabase.from("shipments").select("*").eq("id", shipmentId).single();

      //   if (fetchError || !shipment) {
      //     return res.status(404).json({ error: true, message: "Shipment not found" });
      //   }

      //   // Format shipment number with proper prefix and padding
      //   const formattedShipmentNumber = `SH-${String(shipment.number).padStart(5, "0")}`;

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      //     return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
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
      //     // Shipment Summary Section
      //     rpt.print("Shipment Summary", { x: 40, y: 40, fontSize: 20, bold: true });

      //     // Status badge (top right)
      //     if (shipment.status === "Completed" || shipment.status === "Delivered") {
      //       rpt.print("DELIVERED", { x: 500, y: 40, fontSize: 12, color: "green" });
      //     }

      //     // Shipment details grid
      //     rpt.print("Shipment Number", { x: 40, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formattedShipmentNumber, { x: 40, y: 95, fontSize: 12 });

      //     rpt.print("Shipment Date", { x: 250, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(shipment.shipping_date), { x: 250, y: 95, fontSize: 12 });

      //     rpt.print("Due Date", { x: 460, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(shipment.due_date), { x: 460, y: 95, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 120, y2: 120 });

      //     // Carrier Information Section
      //     rpt.print("Carrier Information", { x: 40, y: 140, fontSize: 20, bold: true });

      //     rpt.print("Carrier Name", { x: 40, y: 170, fontSize: 10, color: "gray" });
      //     rpt.print(shipment.carrier || "Not Specified", { x: 40, y: 185, fontSize: 12 });

      //     rpt.print("Tracking Number", { x: 40, y: 210, fontSize: 10, color: "gray" });
      //     rpt.print(shipment.tracking_number || "Not Available", { x: 40, y: 225, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 365, y2: 365 });

      //     // Shipment Items Section
      //     rpt.print("Shipment Items", { x: 40, y: 385, fontSize: 20, bold: true });

      //     // Items table header
      //     rpt.print("Item", { x: 40, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 250, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Unit Price", { x: 380, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Total", { x: 510, y: 415, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: 435, y2: 435 });
      //   });

      //   // Detail rows
      //   let currentY = 435;
      //   report.detail((rpt, data) => {
      //     rpt.print(data.name, { x: 40, y: currentY, fontSize: 12 });
      //     rpt.print(data.qty.toString(), { x: 250, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.price), { x: 380, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.total_per_item), { x: 510, y: currentY, fontSize: 12 });
      //     currentY += 25;
      //   });

      //   // Set data source
      //   report.data(shipment.items);

      //   // Footer with totals
      //   report.finalSummary((rpt) => {
      //     // Totals section - start right after the last item
      //     const startY = currentY + 55;

      //     // Totals section
      //     rpt.print("Total Items", { x: 380, y: startY, fontSize: 12 });
      //     rpt.print(shipment.items.length.toString(), { x: 510, y: startY, fontSize: 12 });

      //     rpt.print("Total Value", { x: 380, y: startY + 25, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(shipment.grand_total), { x: 510, y: startY + 25, fontSize: 12, bold: true });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: startY + 50, y2: startY + 50 });

      //     // Delivery Information Section
      //     rpt.print("Delivery Information", { x: 40, y: startY + 70, fontSize: 20, bold: true });

      //     rpt.print("Status", { x: 40, y: startY + 100, fontSize: 10, color: "gray" });
      //     rpt.print(shipment.status, { x: 40, y: startY + 115, fontSize: 12 });

      //     if (shipment.status === "Delivered") {
      //       rpt.print("Delivery Date", { x: 40, y: startY + 140, fontSize: 10, color: "gray" });
      //       rpt.print(formatDate(shipment.delivery_date), { x: 40, y: startY + 155, fontSize: 12 });
      //     }
      //   });

      //   // Render the report
      //   report.render((err) => {
      //     if (err) {
      //       return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
      //     }
      //   });

      //   // Set response headers and pipe the PDF stream
      //   res.setHeader("Content-Type", "application/pdf");
      //   res.setHeader("Content-Disposition", `attachment; filename=${formattedShipmentNumber}.pdf`);
      //   pdfStream.pipe(res);

      //   break;
      // }

      // //   Get Order Report Endpoint
      // case "getOrderReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOrderReport." });
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

      //   const orderId = req.query.id;
      //   if (!orderId) return res.status(400).json({ error: true, message: "Missing order id" });

      //   const { data: order, error: fetchError } = await supabase.from("orders").select("*").eq("id", orderId).single();

      //   if (fetchError || !order) {
      //     return res.status(404).json({ error: true, message: "Order not found" });
      //   }

      //   // Format order number with proper prefix and padding
      //   const formattedOrderNumber = `ORD-${String(order.number).padStart(5, "0")}`;

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      //     return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
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
      //     // Order Summary Section
      //     rpt.print("Purchase Order", { x: 40, y: 40, fontSize: 20, bold: true });

      //     // Status badge (top right)
      //     if (order.status === "Completed" || order.status === "Paid") {
      //       rpt.print("COMPLETED", { x: 500, y: 40, fontSize: 12, color: "green" });
      //     } else if (order.status === "Processing") {
      //       rpt.print("PROCESSING", { x: 500, y: 40, fontSize: 12, color: "blue" });
      //     } else if (order.status === "Pending") {
      //       rpt.print("PENDING", { x: 500, y: 40, fontSize: 12, color: "orange" });
      //     }

      //     // Order details grid
      //     rpt.print("Order Number", { x: 40, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formattedOrderNumber, { x: 40, y: 95, fontSize: 12 });

      //     rpt.print("Order Date", { x: 250, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(order.date), { x: 250, y: 95, fontSize: 12 });

      //     rpt.print("Expected Delivery", { x: 460, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(order.expected_delivery), { x: 460, y: 95, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 120, y2: 120 });

      //     // Order Information Section
      //     rpt.print("Order Details", { x: 40, y: 140, fontSize: 20, bold: true });

      //     // Supplier Information
      //     rpt.print("Supplier", { x: 40, y: 170, fontSize: 10, color: "gray" });
      //     rpt.print(order.supplier_name, { x: 40, y: 185, fontSize: 12 });

      //     // Payment Terms
      //     rpt.print("Payment Terms", { x: 40, y: 210, fontSize: 10, color: "gray" });
      //     rpt.print(order.payment_terms, { x: 40, y: 225, fontSize: 12 });

      //     // Delivery Terms
      //     rpt.print("Delivery Terms", { x: 40, y: 250, fontSize: 10, color: "gray" });
      //     rpt.print(order.delivery_terms, { x: 40, y: 265, fontSize: 12 });

      //     // Purchase Type
      //     if (order.purchase_type) {
      //       rpt.print("Purchase Type", { x: 40, y: 290, fontSize: 10, color: "gray" });
      //       rpt.print(order.purchase_type, { x: 40, y: 305, fontSize: 12 });
      //     }

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 365, y2: 365 });

      //     // Order Items Section
      //     rpt.print("Ordered Items", { x: 40, y: 385, fontSize: 20, bold: true });

      //     // Items table header
      //     rpt.print("Item", { x: 40, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 250, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Unit Price", { x: 380, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Total", { x: 510, y: 415, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: 435, y2: 435 });
      //   });

      //   // Detail rows
      //   let currentY = 435;
      //   report.detail((rpt, data) => {
      //     rpt.print(data.name, { x: 40, y: currentY, fontSize: 12 });
      //     rpt.print(data.qty.toString(), { x: 250, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.price), { x: 380, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.total_per_item), { x: 510, y: currentY, fontSize: 12 });
      //     currentY += 25;
      //   });

      //   // Set data source
      //   report.data(order.items);

      //   // Footer with totals
      //   report.finalSummary((rpt) => {
      //     // Totals section - start right after the last item
      //     const startY = currentY + 55;

      //     // Subtotal
      //     rpt.print("Subtotal", { x: 380, y: startY, fontSize: 12 });
      //     rpt.print(formatCurrency(order.subtotal), { x: 510, y: startY, fontSize: 12 });

      //     // Tax
      //     if (order.tax) {
      //       rpt.print("Tax", { x: 380, y: startY + 25, fontSize: 12 });
      //       rpt.print(formatCurrency(order.tax), { x: 510, y: startY + 25, fontSize: 12 });
      //     }

      //     // Shipping
      //     if (order.shipping_cost) {
      //       rpt.print("Shipping", { x: 380, y: startY + 50, fontSize: 12 });
      //       rpt.print(formatCurrency(order.shipping_cost), { x: 510, y: startY + 50, fontSize: 12 });
      //     }

      //     // Grand Total
      //     const grandTotalY = startY + (order.shipping_cost ? 75 : 50);
      //     rpt.print("Grand Total", { x: 380, y: grandTotalY, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(order.grand_total), { x: 510, y: grandTotalY, fontSize: 12, bold: true });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: grandTotalY + 25, y2: grandTotalY + 25 });

      //     // Terms and Notes Section
      //     if (order.terms_and_conditions) {
      //       rpt.print("Terms and Conditions", { x: 40, y: grandTotalY + 45, fontSize: 20, bold: true });
      //       rpt.print(order.terms_and_conditions, { x: 40, y: grandTotalY + 70, fontSize: 10 });
      //     }

      //     // Approval Section
      //     rpt.print("Approval", { x: 40, y: grandTotalY + 120, fontSize: 20, bold: true });

      //     // Prepared by
      //     rpt.line({ x1: 40, x2: 200, y1: grandTotalY + 175, y2: grandTotalY + 175 });
      //     rpt.print("Prepared by", { x: 40, y: grandTotalY + 190, fontSize: 10 });

      //     // Approved by
      //     rpt.line({ x1: 250, x2: 410, y1: grandTotalY + 175, y2: grandTotalY + 175 });
      //     rpt.print("Approved by", { x: 250, y: grandTotalY + 190, fontSize: 10 });

      //     // Date
      //     rpt.line({ x1: 460, x2: 555, y1: grandTotalY + 175, y2: grandTotalY + 175 });
      //     rpt.print("Date", { x: 460, y: grandTotalY + 190, fontSize: 10 });
      //   });

      //   // Render the report
      //   report.render((err) => {
      //     if (err) {
      //       return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
      //     }
      //   });

      //   // Set response headers and pipe the PDF stream
      //   res.setHeader("Content-Type", "application/pdf");
      //   res.setHeader("Content-Disposition", `attachment; filename=${formattedOrderNumber}.pdf`);
      //   pdfStream.pipe(res);

      //   break;
      // }

      // // Get Offer Report Endpoint
      // case "getOfferReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOfferReport." });
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

      //   const offerId = req.query.id;
      //   if (!offerId) return res.status(400).json({ error: true, message: "Missing offer id" });

      //   const { data: offer, error: fetchError } = await supabase.from("offers").select("*").eq("id", offerId).single();

      //   if (fetchError || !offer) {
      //     return res.status(404).json({ error: true, message: "Offer not found" });
      //   }

      //   // Format offer number with proper prefix and padding
      //   const formattedOfferNumber = `OFR-${String(offer.number).padStart(5, "0")}`;

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      //     return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
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
      //     // Offer Summary Section
      //     rpt.print("Price Quotation", { x: 40, y: 40, fontSize: 20, bold: true });

      //     // Status badge (top right)
      //     if (offer.status === "Accepted") {
      //       rpt.print("ACCEPTED", { x: 500, y: 40, fontSize: 12, color: "green" });
      //     }

      //     // Offer details grid
      //     rpt.print("Quotation Number", { x: 40, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formattedOfferNumber, { x: 40, y: 95, fontSize: 12 });

      //     rpt.print("Date", { x: 250, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(offer.date), { x: 250, y: 95, fontSize: 12 });

      //     rpt.print("Valid Until", { x: 460, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(offer.expiry_date), { x: 460, y: 95, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 120, y2: 120 });

      //     // Offer Information Section
      //     rpt.print("Quotation Details", { x: 40, y: 140, fontSize: 20, bold: true });

      //     rpt.print("Status", { x: 40, y: 170, fontSize: 10, color: "gray" });
      //     rpt.print(offer.status, { x: 40, y: 185, fontSize: 12 });

      //     if (offer.discount_terms) {
      //       rpt.print("Discount Terms", { x: 40, y: 210, fontSize: 10, color: "gray" });
      //       rpt.print(offer.discount_terms, { x: 40, y: 225, fontSize: 12 });
      //     }

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 365, y2: 365 });

      //     // Offer Items Section
      //     rpt.print("Items & Pricing", { x: 40, y: 385, fontSize: 20, bold: true });

      //     // Items table header
      //     rpt.print("Item", { x: 40, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 250, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Unit Price", { x: 380, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Total", { x: 510, y: 415, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: 435, y2: 435 });
      //   });

      //   // Detail rows
      //   let currentY = 435;
      //   report.detail((rpt, data) => {
      //     rpt.print(data.name, { x: 40, y: currentY, fontSize: 12 });
      //     rpt.print(data.qty.toString(), { x: 250, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.price), { x: 380, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.total_per_item), { x: 510, y: currentY, fontSize: 12 });
      //     currentY += 25;
      //   });

      //   // Set data source
      //   report.data(offer.items);

      //   // Footer with totals
      //   report.finalSummary((rpt) => {
      //     // Totals section - start right after the last item
      //     const startY = currentY + 55;

      //     // Totals section
      //     rpt.print("Total Items", { x: 380, y: startY, fontSize: 12 });
      //     rpt.print(offer.items.length.toString(), { x: 510, y: startY, fontSize: 12 });

      //     rpt.print("Grand Total", { x: 380, y: startY + 25, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(offer.grand_total), { x: 510, y: startY + 25, fontSize: 12, bold: true });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: startY + 50, y2: startY + 50 });

      //     // Terms and Conditions Section
      //     rpt.print("Terms and Conditions", { x: 40, y: startY + 70, fontSize: 20, bold: true });

      //     const terms = [
      //       "1. This quotation is valid until the expiry date mentioned above.",
      //       "2. Prices are subject to change without prior notice.",
      //       "3. Payment terms as specified in the quotation.",
      //       "4. Delivery timeline will be confirmed upon order confirmation.",
      //     ];

      //     terms.forEach((term, index) => {
      //       rpt.print(term, { x: 40, y: startY + 100 + index * 20, fontSize: 10 });
      //     });

      //     if (offer.tags && offer.tags.length > 0) {
      //       rpt.print("Tags", { x: 40, y: startY + 190, fontSize: 10, color: "gray" });
      //       rpt.print(offer.tags.join(", "), { x: 40, y: startY + 205, fontSize: 12 });
      //     }
      //   });

      //   // Render the report
      //   report.render((err) => {
      //     if (err) {
      //       return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
      //     }
      //   });

      //   // Set response headers and pipe the PDF stream
      //   res.setHeader("Content-Type", "application/pdf");
      //   res.setHeader("Content-Disposition", `attachment; filename=${formattedOfferNumber}.pdf`);
      //   pdfStream.pipe(res);

      //   break;
      // }

      // // Get Request Report Endpoint
      // case "getRequestReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getRequestReport." });
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

      //   const requestId = req.query.id;
      //   if (!requestId) return res.status(400).json({ error: true, message: "Missing request id" });

      //   const { data: request, error: fetchError } = await supabase.from("requests").select("*").eq("id", requestId).single();

      //   if (fetchError || !request) {
      //     return res.status(404).json({ error: true, message: "Request not found" });
      //   }

      //   // Format request number with proper prefix and padding
      //   const formattedRequestNumber = `REQ-${String(request.number).padStart(5, "0")}`;

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      //     return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
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
      //     // Request Summary Section
      //     rpt.print("Purchase Request", { x: 40, y: 40, fontSize: 20, bold: true });

      //     // Status badge (top right)
      //     if (request.status === "Completed") {
      //       rpt.print("COMPLETED", { x: 500, y: 40, fontSize: 12, color: "green" });
      //     } else if (request.status === "Pending") {
      //       rpt.print("PENDING", { x: 500, y: 40, fontSize: 12, color: "orange" });
      //     }

      //     // Request details grid
      //     rpt.print("Request Number", { x: 40, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formattedRequestNumber, { x: 40, y: 95, fontSize: 12 });

      //     rpt.print("Request Date", { x: 250, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(request.date), { x: 250, y: 95, fontSize: 12 });

      //     rpt.print("Due Date", { x: 460, y: 80, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(request.due_date), { x: 460, y: 95, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 120, y2: 120 });

      //     // Request Information Section
      //     rpt.print("Request Details", { x: 40, y: 140, fontSize: 20, bold: true });

      //     rpt.print("Requested By", { x: 40, y: 170, fontSize: 10, color: "gray" });
      //     rpt.print(request.requested_by, { x: 40, y: 185, fontSize: 12 });

      //     rpt.print("Urgency Level", { x: 40, y: 210, fontSize: 10, color: "gray" });
      //     rpt.print(request.urgency, { x: 40, y: 225, fontSize: 12 });

      //     rpt.print("Status", { x: 40, y: 250, fontSize: 10, color: "gray" });
      //     rpt.print(request.status, { x: 40, y: 265, fontSize: 12 });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: 365, y2: 365 });

      //     // Request Items Section
      //     rpt.print("Requested Items", { x: 40, y: 385, fontSize: 20, bold: true });

      //     // Items table header
      //     rpt.print("Item", { x: 40, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 250, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Est. Price", { x: 380, y: 415, fontSize: 12, bold: true });
      //     rpt.print("Est. Total", { x: 510, y: 415, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: 435, y2: 435 });
      //   });

      //   // Detail rows
      //   let currentY = 435;
      //   report.detail((rpt, data) => {
      //     rpt.print(data.name, { x: 40, y: currentY, fontSize: 12 });
      //     rpt.print(data.qty.toString(), { x: 250, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.price), { x: 380, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(data.total_per_item), { x: 510, y: currentY, fontSize: 12 });
      //     currentY += 25;
      //   });

      //   // Set data source
      //   report.data(request.items);

      //   // Footer with totals
      //   report.finalSummary((rpt) => {
      //     // Totals section - start right after the last item
      //     const startY = currentY + 55;

      //     // Totals section
      //     rpt.print("Total Items", { x: 380, y: startY, fontSize: 12 });
      //     rpt.print(request.items.length.toString(), { x: 510, y: startY, fontSize: 12 });

      //     rpt.print("Estimated Total", { x: 380, y: startY + 25, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(request.grand_total), { x: 510, y: startY + 25, fontSize: 12, bold: true });

      //     // Separator line
      //     rpt.line({ x1: 40, x2: 555, y1: startY + 50, y2: startY + 50 });

      //     // Additional Information Section
      //     rpt.print("Additional Information", { x: 40, y: startY + 70, fontSize: 20, bold: true });

      //     if (request.tags && request.tags.length > 0) {
      //       rpt.print("Tags", { x: 40, y: startY + 100, fontSize: 10, color: "gray" });
      //       rpt.print(request.tags.join(", "), { x: 40, y: startY + 115, fontSize: 12 });
      //     }

      //     // Approval Section
      //     rpt.print("Approval Status", { x: 40, y: startY + 145, fontSize: 20, bold: true });

      //     rpt.print("Current Status", { x: 40, y: startY + 175, fontSize: 10, color: "gray" });
      //     rpt.print(request.status, { x: 40, y: startY + 190, fontSize: 12 });

      //     // Add signature lines if needed
      //     if (request.status === "Pending") {
      //       rpt.line({ x1: 40, x2: 200, y1: startY + 250, y2: startY + 250 });
      //       rpt.print("Requester Signature", { x: 40, y: startY + 265, fontSize: 10 });

      //       rpt.line({ x1: 250, x2: 410, y1: startY + 250, y2: startY + 250 });
      //       rpt.print("Approver Signature", { x: 250, y: startY + 265, fontSize: 10 });
      //     }
      //   });

      //   // Render the report
      //   report.render((err) => {
      //     if (err) {
      //       return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
      //     }
      //   });

      //   // Set response headers and pipe the PDF stream
      //   res.setHeader("Content-Type", "application/pdf");
      //   res.setHeader("Content-Disposition", `attachment; filename=${formattedRequestNumber}.pdf`);
      //   pdfStream.pipe(res);

      //   break;
      // }

      // Non-existent Endpoint
      default:
        return res.status(404).json({ error: true, message: "Endpoint not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: true, message: error.message || "Unexpected server error" });
  }
};
