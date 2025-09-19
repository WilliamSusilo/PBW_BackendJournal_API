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
const formidable = require("formidable");

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

      for (const key in fields) {
        body[key] = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
      }

      files = parsedFiles;
      action = body.action;

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

      // Add New Sales Endpoint (Form Data)
      case "addNewSale": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addSale." });
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

        try {
          let { customer_name, invoice_date, due_date, status, items: itemsRaw, grand_total, memo, type, tax_details } = req.body;

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

                const fileName = `salesInvoices/${user.id}_${Date.now()}_${file.originalFilename}`;

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

          if (!customer_name || !invoice_date || !due_date || !status || !items || items.length === 0 || !grand_total) {
            return res.status(400).json({ error: true, message: "Missing required fields" });
          }

          const invoiceDate = new Date(invoice_date);
          const month = invoiceDate.getMonth() + 1;
          const year = invoiceDate.getFullYear();

          const prefix = `${year}${String(month).padStart(2, "0")}`;

          const { data: latestSale, error: fetchError } = await supabase
            .from("sales")
            .select("number")
            .gte("invoice_date", `${year}-${String(month).padStart(2, "0")}-01`)
            .lt("invoice_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
            .order("number", { ascending: false })
            .limit(1);

          if (fetchError) {
            return res.status(500).json({ error: true, message: "Failed to fetch latest sale number: " + fetchError.message });
          }

          let counter = 1;
          if (latestSale && latestSale.length > 0) {
            const lastNumber = latestSale[0].number.toString();
            const lastCounter = parseInt(lastNumber.slice(6), 10);
            counter = lastCounter + 1;
          }

          const nextInvoiceNumber = parseInt(`${prefix}${counter}`, 10);

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.unit_price) || 0;
            const total_per_item = qty * unit_price;
            return { ...item, total_per_item };
          });

          const { error: insertError } = await supabase.from("sales").insert([
            {
              user_id: user.id,
              number: nextInvoiceNumber,
              customer_name,
              invoice_date,
              due_date,
              status,
              items: updatedItems,
              grand_total,
              memo,
              type,
              tax_details,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (insertError) {
            return res.status(500).json({ error: true, message: "Failed to create sale: " + insertError.message });
          }

          return res.status(201).json({ error: false, message: "Sale created successfully" });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Add Order Delivery Endpoint
      case "addNewOrderDelivery": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addOrderDelivery." });
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

        try {
          let { customer_name, customer_phone, customer_email, shipping_address, order_date, delivery_date, shipping_method, payment_method, status, tracking_number, notes, items: itemsRaw, grand_total, memo, type, tax_details } = req.body;

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

                const fileName = `salesOrderDeliveries/${user.id}_${Date.now()}_${file.originalFilename}`;

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

          if (!customer_name || !customer_phone || !customer_email || !shipping_address || !order_date || !delivery_date || !shipping_method || !payment_method || !status || !items || items.length === 0 || !grand_total) {
            return res.status(400).json({ error: true, message: "Missing required fields" });
          }

          const orderDate = new Date(order_date);
          const month = orderDate.getMonth() + 1;
          const year = orderDate.getFullYear();

          const prefix = `${year}${String(month).padStart(2, "0")}`;

          const { data: latestOrder, error: fetchError } = await supabase
            .from("order_deliveries")
            .select("number")
            .gte("order_date", `${year}-${String(month).padStart(2, "0")}-01`)
            .lt("order_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
            .order("number", { ascending: false })
            .limit(1);

          if (fetchError) {
            return res.status(500).json({ error: true, message: "Failed to fetch latest order number: " + fetchError.message });
          }

          let counter = 1;
          if (latestOrder && latestOrder.length > 0) {
            const lastNumber = latestOrder[0].number.toString();
            const lastCounter = parseInt(lastNumber.slice(6), 10);
            counter = lastCounter + 1;
          }

          const nextOrderNumber = parseInt(`${prefix}${counter}`, 10);

          const updatedItems = items.map((item) => {
            const quantity = Number(item.quantity) || 0;
            const price = Number(item.price) || 0;
            const discount = Number(item.discount) || 0;
            return { ...item, total_per_item: quantity * price - discount };
          });

          const { error: insertError } = await supabase.from("order_deliveries").insert([
            {
              user_id: user.id,
              number: nextOrderNumber,
              customer_name,
              customer_phone,
              customer_email,
              shipping_address,
              order_date,
              delivery_date,
              shipping_method,
              payment_method,
              status,
              tracking_number,
              notes,
              items: updatedItems,
              grand_total,
              memo,
              type,
              tax_details,
              attachment_url: attachment_urls || null,
            },
          ]);

          if (insertError) {
            return res.status(500).json({ error: true, message: "Failed to create order delivery: " + insertError.message });
          }

          return res.status(201).json({ error: false, message: "Order delivery created successfully" });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      case "addNewQuotation": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addQuotation." });
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

        try {
          let { customer_name, quotation_date, valid_until, status, terms, items: itemsRaw, total, memo, type, tax_details } = req.body;

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

                const fileName = `salesQuotations/${user.id}_${Date.now()}_${file.originalFilename}`;

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

          if (!customer_name || !quotation_date || !valid_until || !status || !terms || !items || items.length === 0 || !total) {
            return res.status(400).json({ error: true, message: "Missing required fields" });
          }

          // Generate quotation number
          const quoteDate = new Date(quotation_date);
          const month = quoteDate.getMonth() + 1;
          const year = quoteDate.getFullYear();
          const prefix = `${year}${String(month).padStart(2, "0")}`;

          const { data: latestQuote, error: fetchError } = await supabase
            .from("quotations")
            .select("number")
            .gte("quotation_date", `${year}-${String(month).padStart(2, "0")}-01`)
            .lt("quotation_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
            .order("number", { ascending: false })
            .limit(1);

          if (fetchError) {
            return res.status(500).json({
              error: true,
              message: "Failed to fetch latest quotation number: " + fetchError.message,
            });
          }

          let counter = 1;
          if (latestQuote && latestQuote.length > 0) {
            const lastNumber = latestQuote[0].number.toString();
            const lastCounter = parseInt(lastNumber.slice(6), 10);
            counter = lastCounter + 1;
          }

          const nextQuotationNumber = parseInt(`${prefix}${counter}`, 10);

          const updatedItems = items.map((item) => {
            const qty = Number(item.qty) || 0;
            const unit_price = Number(item.unit_price) || 0;
            const total_per_item = qty * unit_price;

            return {
              ...item,
              total_per_item,
            };
          });

          const { error: insertError } = await supabase.from("quotations").insert([
            {
              user_id: user.id,
              number: nextQuotationNumber,
              customer_name,
              quotation_date,
              valid_until,
              status,
              terms,
              items: updatedItems,
              total,
              memo,
              type,
              tax_details,
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

        try {
          let { type, date, discount_terms, expiry_date, due_date, status, tags, items: itemsRaw, grand_total, memo } = req.body;

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

                const fileName = `salesOffers/${user.id}_${Date.now()}_${file.originalFilename}`;

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

          const requestDate = new Date(date);
          const month = requestDate.getMonth() + 1; // 0-based
          const year = requestDate.getFullYear();

          // Generate prefix for this month: YYYYMM
          const prefix = `${year}${String(month).padStart(2, "0")}`;

          // Fetch latest offer number
          const { data: latestOffer, error: fetchError } = await supabase
            .from("offers_sales")
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

          const { error } = await supabase.from("offers_sales").insert([
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

      // Edit Sales Endpoint
      case "editNewSale": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editSale." });
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

        try {
          const { id, customer_name, invoice_date, due_date, status, items: itemsRaw, grand_total, memo, type, tax_details, filesToDelete } = req.body;

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
                const fileName = `salesInvoices/${user.id}_${Date.now()}_${file.originalFilename}`;

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
            .from("sales")
            .update({
              customer_name,
              invoice_date,
              due_date,
              status,
              items: updatedItems,
              grand_total,
              memo,
              type,
              tax_details,
              attachment_url: newAttachmentUrls || null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id);

          if (updateError) {
            return res.status(500).json({ error: true, message: "Failed to update sale: " + updateError.message });
          }

          return res.status(200).json({ error: false, message: "Sale updated successfully" });
        } catch (e) {
          return res.status(500).json({ error: true, message: "Server error: " + e.message });
        }
      }

      // Edit Order Delivery Endpoint
      case "editNewOrderDelivery": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editOrderDelivery." });
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

        try {
          const {
            id,
            customer_name,
            customer_phone,
            customer_email,
            shipping_address,
            order_date,
            delivery_date,
            shipping_method,
            payment_method,
            status,
            tracking_number,
            notes,
            items: itemsRaw,
            grand_total,
            memo,
            type,
            tax_details,
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
                const fileName = `salesOrderDeliveries/${user.id}_${Date.now()}_${file.originalFilename}`;

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
            const quantity = Number(item.quantity) || 0;
            const price = Number(item.price) || 0;
            const discount = Number(item.discount) || 0;
            return {
              ...item,
              total_per_item: quantity * price - discount,
            };
          });

          const { error: updateError } = await supabase
            .from("order_deliveries")
            .update({
              customer_name,
              customer_phone,
              customer_email,
              shipping_address,
              order_date,
              delivery_date,
              shipping_method,
              payment_method,
              status,
              tracking_number,
              notes,
              items: updatedItems,
              grand_total,
              memo,
              type,
              tax_details,
              attachment_url: newAttachmentUrls || null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id);

          if (updateError) {
            return res.status(500).json({ error: true, message: "Failed to update order delivery: " + updateError.message });
          }

          return res.status(200).json({ error: false, message: "Order delivery updated successfully" });
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

        try {
          const { id, customer_name, quotation_date, valid_until, status, terms, items: itemsRaw, total, memo, type, tax_details, filesToDelete } = req.body;

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
                const fileName = `salesQuotations/${user.id}_${Date.now()}_${file.originalFilename}`;

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
            .from("quotations")
            .update({
              customer_name,
              quotation_date,
              valid_until,
              status,
              terms,
              items: updatedItems,
              total,
              memo,
              type,
              tax_details,
              attachment_url: newAttachmentUrls || null,
              updated_at: new Date().toISOString(),
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
                const fileName = `salesOffers/${user.id}_${Date.now()}_${file.originalFilename}`;

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
          const { data: verifyData, error: verifyError } = await supabase.from("offers_sales").select("id").eq("id", id);

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
          const { error: updateError } = await supabase.from("offers_sales").update(updateData).eq("id", id).eq("user_id", user.id);

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

      // Delete Sale Endpoint
      case "deleteSale": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteSale." });
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
        // const allowedRoles = ["sales", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Sale ID is required" });
        }

        const { data: sale, error: fetchError } = await supabase.from("sales").select("id").eq("id", id);

        if (fetchError || !sale || sale.length === 0) {
          return res.status(404).json({ error: true, message: "Sale not found" });
        }

        const { error: deleteError } = await supabase.from("sales").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete sale: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Sale deleted successfully" });
      }

      // Delete Order & Delivery Endpoint
      case "deleteOrderDelivery": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteOrderDelivery." });
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
        // const allowedRoles = ["sales", "logistics", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Order Delivery ID is required" });
        }

        const { data: sale, error: fetchError } = await supabase.from("order_deliveries").select("id").eq("id", id);

        if (fetchError || !sale || sale.length === 0) {
          return res.status(404).json({ error: true, message: "Order delivery not found" });
        }

        const { error: deleteError } = await supabase.from("order_deliveries").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete order delivery: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Order delivery deleted successfully" });
      }

      // Delete Quotation Endpoint
      case "deleteQuotation": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteQuotation." });
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
        // const allowedRoles = ["sales", "marketing", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Quotation ID is required" });
        }

        const { data: sale, error: fetchError } = await supabase.from("quotations").select("id").eq("id", id);

        if (fetchError || !sale || sale.length === 0) {
          return res.status(404).json({ error: true, message: "Quotation not found" });
        }

        const { error: deleteError } = await supabase.from("quotations").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete quotation: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Quotation deleted successfully" });
      }

      // Delete Offer Endpoint
      case "deleteOffer": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteOffer." });
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
        // const allowedRoles = ["sales", "marketing", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Offer ID is required" });
        }

        const { data: sale, error: fetchError } = await supabase.from("offers_sales").select("id").eq("id", id);

        if (fetchError || !sale || sale.length === 0) {
          return res.status(404).json({ error: true, message: "Offer not found" });
        }

        const { error: deleteError } = await supabase.from("offers_sales").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete offer: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Offer deleted successfully" });
      }

      // Get Sale Endpoint
      case "getSale": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getSale." });
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
        // const allowedRoles = ["sales", "manager", "admin"];
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

        let query = supabase.from("sales").select("*").order("invoice_date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["customer_name"];
          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("grand_total.eq." + parseFloat(search));
          }

          // For detect search like "Sales Invoice #00588"
          const codeMatch = search.match(/^sales invoice\s?#?0*(\d{7,})$/i);
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

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch sales: " + error.message });

        const formattedData = data.map((sale) => ({
          ...sale,
          number: `Sales Invoice #${String(sale.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Order Delivery Endpoint
      case "getOrderDelivery": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOrderDelivery." });
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
        // const allowedRoles = ["sales", "logistics", "manager", "admin"];
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

        let query = supabase.from("order_deliveries").select("*").order("order_date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["customer_name"];
          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("grand_total.eq." + parseFloat(search));
          }

          // For detect search like "Order #00588"
          const codeMatch = search.match(/^order\s?#?0*(\d{7,})$/i);
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

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch order: " + error.message });

        const formattedData = data.map((sale) => ({
          ...sale,
          number: `Order #${String(sale.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
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

        let query = supabase.from("quotations").select("*").order("quotation_date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["customer_name"];
          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);

          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("number.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("total.eq." + parseFloat(search));
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

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch quotation: " + error.message });

        const formattedData = data.map((sale) => ({
          ...sale,
          number: `Quotation #${String(sale.number).padStart(5, "0")}`,
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

        let query = supabase.from("offers_sales").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["discount_terms"];
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

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch offers: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${"OFR"}-${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Sale Report Endpoint
      case "getSaleReport": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getSaleReport." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser(token);

        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        const saleId = req.query.id;
        if (!saleId) return res.status(400).json({ error: true, message: "Missing sale id" });

        const { data: sale, error: fetchError } = await supabase.from("sales").select("*").eq("id", saleId).single();

        if (fetchError || !sale) {
          return res.status(404).json({ error: true, message: "Sale not found" });
        }

        // Format invoice number with proper prefix and padding
        const formattedInvoiceNumber = `INV-${String(sale.number).padStart(5, "0")}`;

        // Format currency function
        const formatCurrency = (amount) => {
          if (!amount) return "Rp 0";
          return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
        };

        // Format date function
        const formatDate = (dateString) => {
          const date = new Date(dateString);
          return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
        };

        const { Report } = require("fluentreports");
        const stream = require("stream");
        const pdfStream = new stream.PassThrough();

        // Create report with A4 page size
        const report = new Report(pdfStream, {
          paper: "A4",
          margins: { top: 40, left: 40, right: 40, bottom: 40 },
        });

        // Header Section
        report.pageHeader((rpt) => {
          // Invoice Details Section
          rpt.print("Invoice Details", { x: 40, y: 40, fontSize: 16, bold: true });

          // Status badge (top right)
          const status = sale.status || "Unpaid";
          rpt.print(status.toUpperCase(), { x: 500, y: 40, fontSize: 12, color: status.toLowerCase() === "paid" ? "green" : "red" });

          // Invoice details grid
          rpt.print("Invoice Number", { x: 40, y: 70, fontSize: 10, color: "gray" });
          rpt.print(formattedInvoiceNumber, { x: 40, y: 85, fontSize: 12 });

          rpt.print("Invoice Date", { x: 200, y: 70, fontSize: 10, color: "gray" });
          rpt.print(formatDate(sale.invoice_date), { x: 200, y: 85, fontSize: 12 });

          rpt.print("Due Date", { x: 360, y: 70, fontSize: 10, color: "gray" });
          rpt.print(formatDate(sale.due_date), { x: 360, y: 85, fontSize: 12 });

          // Separator line
          rpt.line({ x1: 40, x2: 555, y1: 105, y2: 105 });

          // Customer Information Section
          rpt.print("Customer Information", { x: 40, y: 125, fontSize: 16, bold: true });

          rpt.print("Customer Name", { x: 40, y: 155, fontSize: 10, color: "gray" });
          rpt.print(sale.customer_name, { x: 40, y: 170, fontSize: 12 });

          // Separator line
          rpt.line({ x1: 40, x2: 555, y1: 190, y2: 190 });

          // Invoice Items Section
          rpt.print("Invoice Items", { x: 40, y: 210, fontSize: 16, bold: true });

          // Items table header
          rpt.print("Item", { x: 40, y: 240, fontSize: 12, bold: true });
          rpt.print("Quantity", { x: 250, y: 240, fontSize: 12, bold: true });
          rpt.print("Unit Price", { x: 350, y: 240, fontSize: 12, bold: true });
          rpt.print("Total", { x: 470, y: 240, fontSize: 12, bold: true });

          // Separator line below header
          rpt.line({ x1: 40, x2: 555, y1: 260, y2: 260 });
        });

        // Detail rows
        let currentY = 280; // Increased initial Y position for better spacing
        report.detail((rpt, data) => {
          if (!data) return; // Skip if no data

          // Ensure all required fields exist with fallbacks
          const itemName = data.name || data.product_name || "Unknown Item";
          const quantity = data.quantity || 0;
          const price = data.price || data.unit_price || 0;
          const total = data.total_per_item || quantity * price || 0;

          // Print item details
          rpt.print(itemName, { x: 40, y: currentY, fontSize: 12 });
          rpt.print(quantity.toString(), { x: 250, y: currentY, fontSize: 12 });
          rpt.print(formatCurrency(price), { x: 350, y: currentY, fontSize: 12 });
          rpt.print(formatCurrency(total), { x: 470, y: currentY, fontSize: 12 });

          // Draw light gray separator line
          rpt.line({ x1: 40, x2: 555, y1: currentY + 15, y2: currentY + 15, color: "gray" });

          currentY += 30; // Increased spacing between items
        });

        // Set data source - ensure items is an array
        const items = Array.isArray(sale.items) ? sale.items : [];
        report.data(items);

        // Footer with totals and payment info
        report.finalSummary((rpt) => {
          // Start after the last item
          const startY = currentY + 50;

          // Calculate grand total from items if not available in sale
          const calculatedTotal = items.reduce((sum, item) => {
            const itemTotal = item.total_per_item || item.quantity * item.price || 0;
            return sum + itemTotal;
          }, 0);

          const grandTotal = sale.grand_total || calculatedTotal;

          // Grand Total section with bold line
          rpt.line({ x1: 40, x2: 555, y1: startY, y2: startY, lineWidth: 2 });

          // Grand Total amount (right-aligned)
          rpt.print("Grand Total:", { x: 350, y: startY + 20, fontSize: 14, bold: true });
          rpt.print(formatCurrency(grandTotal), { x: 470, y: startY + 20, fontSize: 14, bold: true });

          // Separator line
          rpt.line({ x1: 40, x2: 555, y1: startY + 50, y2: startY + 50 });

          // Payment Information Section
          rpt.print("Payment Information", { x: 40, y: startY + 70, fontSize: 16, bold: true });

          // Payment Status
          rpt.print("Payment Status", { x: 40, y: startY + 100, fontSize: 10, color: "gray" });
          const paymentStatus = sale.status === "Paid" ? "Paid" : "Overdue";
          rpt.print(paymentStatus, { x: 40, y: startY + 115, fontSize: 12, color: paymentStatus === "Paid" ? "green" : "red" });

          // Balance Due
          rpt.print("Balance Due", { x: 40, y: startY + 145, fontSize: 10, color: "gray" });
          const balanceDue = sale.status === "Paid" ? 0 : grandTotal;
          rpt.print(formatCurrency(balanceDue), { x: 40, y: startY + 160, fontSize: 12 });
        });

        // Render the report
        report.render((err) => {
          if (err) {
            return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
          }
        });

        // Set response headers and pipe the PDF stream
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename=${formattedInvoiceNumber}.pdf`);
        pdfStream.pipe(res);

        break;
      }

      //   Summary Sales Endpoint
      case "summarySale": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for summarySale." });
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

        const today = new Date();
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(today.getDate() - 30);

        // Fetch all sales for the user
        const { data: sales, error: fetchError } = await supabase.from("sales").select("invoice_date, grand_total, status");

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sales: " + fetchError.message });
        }

        // Process grand_total
        const unpaidTotal = sales
          .filter((sale) => {
            return sale.status === "Unpaid";
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        const last30DaysTotal = sales
          .filter((sale) => {
            const saleDate = new Date(sale.invoice_date);
            return saleDate >= thirtyDaysAgo && saleDate <= today;
          })
          .reduce((sum, sale) => sum + (sale.grand_total || 0), 0);

        return res.status(200).json({
          error: false,
          data: {
            unpaid_total: unpaidTotal,
            last_30_days_total: last30DaysTotal,
          },
        });
      }

      // =============================================================
      // >>>>>>>>>>>>>>>>>  OLD ENDPOINT  <<<<<<<<<<<<<
      // =============================================================
      // Add Sales Endpoint
      case "addSale": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addSale." });
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
        // const allowedRoles = ["sales", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { customer_name, invoice_date, due_date, status, items, grand_total } = req.body;

        if (!customer_name || !invoice_date || !due_date || !status || !items || items.length === 0 || !grand_total) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const invoiceDate = new Date(invoice_date);
        const month = invoiceDate.getMonth() + 1;
        const year = invoiceDate.getFullYear();

        const prefix = `${year}${String(month).padStart(2, "0")}`;

        const { data: latestSale, error: fetchError } = await supabase
          .from("sales")
          .select("number")
          .gte("invoice_date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("invoice_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest sale number: " + fetchError.message });
        }

        let counter = 1;
        if (latestSale && latestSale.length > 0) {
          const lastNumber = latestSale[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }

        const nextInvoiceNumber = parseInt(`${prefix}${counter}`, 10);

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

        const { error: insertError } = await supabase.from("sales").insert([
          {
            user_id: user.id,
            number: nextInvoiceNumber,
            customer_name,
            invoice_date,
            due_date,
            status,
            items: updatedItems,
            grand_total,
          },
        ]);

        if (insertError) return res.status(500).json({ error: true, message: "Failed to create sale: " + insertError.message });

        return res.status(201).json({ error: false, message: "Sale created successfully" });
      }

      // Add Order Delivery Endpoint
      case "addOrderDelivery": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addOrderDelivery." });
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
        // const allowedRoles = ["sales", "logistics", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { customer_name, customer_phone, customer_email, shipping_address, order_date, delivery_date, shipping_method, payment_method, status, tracking_number, notes, items, grand_total } = req.body;

        if (!customer_name || !customer_phone || !customer_email || !shipping_address || !order_date || !delivery_date || !shipping_method || !payment_method || !status || !items || items.length === 0 || !grand_total) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const orderDate = new Date(order_date);
        const month = orderDate.getMonth() + 1;
        const year = orderDate.getFullYear();

        const prefix = `${year}${String(month).padStart(2, "0")}`;

        const { data: latestOrder, error: fetchError } = await supabase
          .from("order_deliveries")
          .select("number")
          .gte("order_date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("order_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest order number: " + fetchError.message });
        }

        let counter = 1;
        if (latestOrder && latestOrder.length > 0) {
          const lastNumber = latestOrder[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }

        const nextOrderNumber = parseInt(`${prefix}${counter}`, 10);

        const updatedItems = items.map((item) => {
          const quantity = Number(item.quantity) || 0;
          const price = Number(item.price) || 0;
          const discount = Number(item.discount) || 0;
          return {
            ...item,
            total_per_item: quantity * price - discount,
          };
        });

        // const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

        const { error: insertError } = await supabase.from("order_deliveries").insert([
          {
            user_id: user.id,
            number: nextOrderNumber,
            customer_name,
            customer_phone,
            customer_email,
            shipping_address,
            order_date,
            delivery_date,
            shipping_method,
            payment_method,
            status,
            tracking_number,
            notes,
            items: updatedItems,
            grand_total,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to create order delivery: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Order delivery created successfully" });
      }

      // Add Quotations Endpoint
      case "addQuotation": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addQuotation." });
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

        const { customer_name, quotation_date, valid_until, status, terms, items, total } = req.body;

        if (!customer_name || !quotation_date || !valid_until || !status || !terms || !items || items.length === 0 || !total) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const quoteDate = new Date(quotation_date);
        const month = quoteDate.getMonth() + 1;
        const year = quoteDate.getFullYear();

        const prefix = `${year}${String(month).padStart(2, "0")}`;

        const { data: latestQuote, error: fetchError } = await supabase
          .from("quotations")
          .select("number")
          .gte("quotation_date", `${year}-${String(month).padStart(2, "0")}-01`)
          .lt("quotation_date", `${year}-${String(month + 1).padStart(2, "0")}-01`)
          .order("number", { ascending: false })
          .limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest quotation number: " + fetchError.message });
        }

        let counter = 1;
        if (latestQuote && latestQuote.length > 0) {
          const lastNumber = latestQuote[0].number.toString();
          const lastCounter = parseInt(lastNumber.slice(6), 10);
          counter = lastCounter + 1;
        }

        const nextQuotationNumber = parseInt(`${prefix}${counter}`, 10);

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

        const { error: insertError } = await supabase.from("quotations").insert([
          {
            user_id: user.id,
            number: nextQuotationNumber,
            customer_name,
            quotation_date,
            valid_until,
            status,
            terms,
            items: updatedItems,
            total,
          },
        ]);

        if (insertError) return res.status(500).json({ error: true, message: "Failed to create quotation: " + insertError.message });

        return res.status(201).json({ error: false, message: "Quotation created successfully" });
      }

      // Edit Sales Endpoint
      case "editSale": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editSale." });
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
        // const allowedRoles = ["sales", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, customer_name, invoice_date, due_date, status, items, grand_total } = req.body;

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
          .from("sales")
          .update({
            customer_name,
            invoice_date,
            due_date,
            status,
            items: updatedItems,
            grand_total,
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update sale: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Sale updated successfully" });
      }

      // Edit Order Delivery Endpoint
      case "editOrderDelivery": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editOrderDelivery." });
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
        // const allowedRoles = ["sales", "logistics", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, customer_name, customer_phone, customer_email, shipping_address, order_date, delivery_date, shipping_method, payment_method, status, tracking_number, notes, items, grand_total } = req.body;

        const updatedItems = items.map((item) => {
          const quantity = Number(item.quantity) || 0;
          const price = Number(item.price) || 0;
          const discount = Number(item.discount) || 0;
          return {
            ...item,
            total_per_item: quantity * price - discount,
          };
        });

        const { error: updateError } = await supabase
          .from("order_deliveries")
          .update({
            customer_name,
            customer_phone,
            customer_email,
            shipping_address,
            order_date,
            delivery_date,
            shipping_method,
            payment_method,
            status,
            tracking_number,
            notes,
            items: updatedItems,
            grand_total,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update order delivery: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Order delivery updated successfully" });
      }

      // Edit Quotations Endpoint
      case "editQuotation": {
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

        const { id, customer_name, quotation_date, valid_until, status, terms, items, total } = req.body;

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
          .from("quotations")
          .update({
            customer_name,
            quotation_date,
            valid_until,
            status,
            terms,
            items: updatedItems,
            total,
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update quotation: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Quotation updated successfully" });
      }

      // =============================================================
      // >>>>>>>>>>>>>>>>>  EXAMPLE FOR FLUENTREPORT  <<<<<<<<<<<<<
      // =============================================================

      // Get Order Delivery Report Endpoint
      // case "getOrderDeliveryReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOrderDeliveryReport." });
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

      //   const deliveryId = req.query.id;
      //   if (!deliveryId) return res.status(400).json({ error: true, message: "Missing delivery id" });

      //   const { data: delivery, error: fetchError } = await supabase.from("order_deliveries").select("*").eq("id", deliveryId).single();

      //   if (fetchError || !delivery) {
      //     return res.status(404).json({ error: true, message: "Order delivery not found" });
      //   }

      //   // Format delivery number with proper prefix and padding
      //   const formattedDeliveryNumber = `ORD-${String(delivery.number).padStart(5, "0")}`;

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     if (!amount) return "Rp 0";
      //     return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
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
      //     rpt.print("Order & Delivery Details", { x: 40, y: 40, fontSize: 16, bold: true });
      //     rpt.print("View and manage order information", { x: 40, y: 60, fontSize: 10, color: "gray" });

      //     // Status badge (top right)
      //     const status = delivery.status || "Unpaid";
      //     rpt.print(status.toUpperCase(), { x: 500, y: 40, fontSize: 12, color: status.toLowerCase() === "paid" ? "green" : "red" });

      //     // Order Summary Section
      //     rpt.print("Order Summary", { x: 40, y: 100, fontSize: 14, bold: true });

      //     // Order details grid - first row
      //     rpt.print("Order Number", { x: 40, y: 130, fontSize: 10, color: "gray" });
      //     rpt.print(formattedDeliveryNumber, { x: 40, y: 145, fontSize: 12 });

      //     rpt.print("Order Date", { x: 200, y: 130, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(delivery.order_date), { x: 200, y: 145, fontSize: 12 });

      //     rpt.print("Delivery Date", { x: 360, y: 130, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(delivery.delivery_date), { x: 360, y: 145, fontSize: 12 });

      //     // Tracking Number on second row
      //     rpt.print("Tracking Number", { x: 40, y: 175, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.tracking_number || "-", { x: 40, y: 190, fontSize: 12 });

      //     // Customer Information Section - adjusted position
      //     rpt.print("Customer Information", { x: 40, y: 230, fontSize: 14, bold: true });

      //     rpt.print("Customer Name", { x: 40, y: 260, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.customer_name, { x: 40, y: 275, fontSize: 12 });

      //     rpt.print("Email", { x: 40, y: 295, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.customer_email || "-", { x: 40, y: 310, fontSize: 12 });

      //     rpt.print("Phone", { x: 40, y: 330, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.customer_phone || "-", { x: 40, y: 345, fontSize: 12 });

      //     rpt.print("Shipping Address", { x: 40, y: 365, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.delivery_address || "-", { x: 40, y: 380, fontSize: 12 });

      //     // Shipping Information Section
      //     rpt.print("Shipping Information", { x: 40, y: 420, fontSize: 14, bold: true });

      //     rpt.print("Shipping Method", { x: 40, y: 450, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.shipping_method || "-", { x: 40, y: 465, fontSize: 12 });

      //     rpt.print("Payment Method", { x: 40, y: 485, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.payment_method || "-", { x: 40, y: 500, fontSize: 12 });

      //     rpt.print("Notes", { x: 40, y: 520, fontSize: 10, color: "gray" });
      //     rpt.print(delivery.notes || "-", { x: 40, y: 535, fontSize: 12 });

      //     // Order Items Section
      //     rpt.print("Order Items", { x: 40, y: 575, fontSize: 14, bold: true });

      //     // Items table header
      //     rpt.print("Item", { x: 40, y: 605, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 250, y: 605, fontSize: 12, bold: true });
      //     rpt.print("Unit Price", { x: 350, y: 605, fontSize: 12, bold: true });
      //     rpt.print("Total", { x: 470, y: 605, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: 625, y2: 625 });
      //   });

      //   // Detail rows - adjusted starting position
      //   let currentY = 645;
      //   report.detail((rpt, data) => {
      //     if (!data) return;

      //     // Ensure all required fields exist with fallbacks
      //     const itemName = data.name || data.product_name || "Unknown Item";
      //     const quantity = data.quantity || 0;
      //     const price = data.price || data.unit_price || 0;
      //     const total = data.total_per_item || quantity * price || 0;

      //     // Print item details
      //     rpt.print(itemName, { x: 40, y: currentY, fontSize: 12 });
      //     rpt.print(quantity.toString(), { x: 250, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(price), { x: 350, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(total), { x: 470, y: currentY, fontSize: 12 });

      //     // Draw light gray separator line
      //     rpt.line({ x1: 40, x2: 555, y1: currentY + 15, y2: currentY + 15, color: "gray" });

      //     currentY += 30;
      //   });

      //   // Set data source - ensure items is an array
      //   const items = Array.isArray(delivery.items) ? delivery.items : [];
      //   report.data(items);

      //   // Footer with grand total
      //   report.finalSummary((rpt) => {
      //     const startY = currentY + 60;

      //     // Calculate grand total
      //     const grandTotal = items.reduce((sum, item) => {
      //       const itemTotal = item.total_per_item || item.quantity * item.price || 0;
      //       return sum + itemTotal;
      //     }, 0);

      //     // Grand Total
      //     rpt.print("Grand Total", { x: 350, y: startY, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(grandTotal), { x: 470, y: startY, fontSize: 12, bold: true });
      //   });

      //   // Render the report
      //   report.render((err) => {
      //     if (err) {
      //       return res.status(500).json({ error: true, message: "Failed to render PDF: " + err.message });
      //     }
      //   });

      //   // Set response headers and pipe the PDF stream
      //   res.setHeader("Content-Type", "application/pdf");
      //   res.setHeader("Content-Disposition", `attachment; filename=${formattedDeliveryNumber}.pdf`);
      //   pdfStream.pipe(res);

      //   break;
      // }

      // // Get Quotation Report Endpoint
      // case "getQuotationReport": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getQuotationReport." });
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

      //   const quotationId = req.query.id;
      //   if (!quotationId) return res.status(400).json({ error: true, message: "Missing quotation id" });

      //   const { data: quotation, error: fetchError } = await supabase.from("quotations").select("*").eq("id", quotationId).single();

      //   if (fetchError || !quotation) {
      //     return res.status(404).json({ error: true, message: "Quotation not found" });
      //   }

      //   // Format quotation number with proper prefix and padding
      //   const formattedQuotationNumber = `QUO-${String(quotation.number).padStart(5, "0")}`;

      //   // Format currency function
      //   const formatCurrency = (amount) => {
      //     if (!amount) return "Rp 0";
      //     return `Rp ${new Intl.NumberFormat("id-ID").format(amount)}`;
      //   };

      //   // Format date function
      //   const formatDate = (dateString) => {
      //     const date = new Date(dateString);
      //     return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
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
      //     rpt.print("Quotation Details", { x: 40, y: 40, fontSize: 16, bold: true });
      //     rpt.print("View and manage quotation information", { x: 40, y: 60, fontSize: 10, color: "gray" });

      //     // Status badge (top right)
      //     const status = quotation.status || "Expired";
      //     rpt.print(status.toUpperCase(), { x: 500, y: 40, fontSize: 12, color: "red" });

      //     // Quotation Summary Section
      //     rpt.print("Quotation Summary", { x: 40, y: 100, fontSize: 14, bold: true });

      //     // Quotation details grid
      //     rpt.print("Quotation Number", { x: 40, y: 130, fontSize: 10, color: "gray" });
      //     rpt.print(formattedQuotationNumber, { x: 40, y: 145, fontSize: 12 });

      //     rpt.print("Quotation Date", { x: 200, y: 130, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(quotation.quotation_date), { x: 200, y: 145, fontSize: 12 });

      //     rpt.print("Valid Until", { x: 360, y: 130, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(quotation.valid_until), { x: 360, y: 145, fontSize: 12 });

      //     rpt.print("Status", { x: 40, y: 175, fontSize: 10, color: "gray" });
      //     rpt.print(quotation.status || "Expired", { x: 40, y: 190, fontSize: 12 });

      //     // Customer Information Section
      //     rpt.print("Customer Information", { x: 40, y: 240, fontSize: 14, bold: true });

      //     rpt.print("Customer Name", { x: 40, y: 270, fontSize: 10, color: "gray" });
      //     rpt.print(quotation.customer_name, { x: 40, y: 285, fontSize: 12 });

      //     // Quotation Items Section
      //     rpt.print("Quotation Items", { x: 40, y: 325, fontSize: 14, bold: true });

      //     // Items table header
      //     rpt.print("Item", { x: 40, y: 355, fontSize: 12, bold: true });
      //     rpt.print("Quantity", { x: 300, y: 355, fontSize: 12, bold: true });
      //     rpt.print("Unit Price", { x: 370, y: 355, fontSize: 12, bold: true });
      //     rpt.print("Total", { x: 470, y: 355, fontSize: 12, bold: true });

      //     // Separator line below header
      //     rpt.line({ x1: 40, x2: 555, y1: 340, y2: 330 });
      //   });

      //   // Detail rows
      //   let currentY = 395;
      //   report.detail((rpt, data) => {
      //     if (!data) return;

      //     // Ensure all required fields exist with fallbacks
      //     const itemName = data.name || data.product_name || "Unknown Item";
      //     const quantity = data.quantity || 0;
      //     const price = data.price || data.unit_price || 0;
      //     const total = data.total_per_item || quantity * price || 0;

      //     // Print item details
      //     rpt.print(itemName, { x: 40, y: currentY, fontSize: 12 });
      //     rpt.print(quantity.toString(), { x: 300, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(price), { x: 370, y: currentY, fontSize: 12 });
      //     rpt.print(formatCurrency(total), { x: 470, y: currentY, fontSize: 12 });

      //     // Draw light gray separator line
      //     rpt.line({ x1: 40, x2: 555, y1: currentY + 15, y2: currentY + 15, color: "gray" });

      //     currentY += 30;
      //   });

      //   // Set data source - ensure items is an array
      //   const items = Array.isArray(quotation.items) ? quotation.items : [];
      //   report.data(items);

      //   // Footer with totals and terms
      //   report.finalSummary((rpt) => {
      //     const startY = currentY + 50;

      //     // Calculate total
      //     const total = items.reduce((sum, item) => {
      //       const itemTotal = item.total_per_item || item.quantity * item.price || 0;
      //       return sum + itemTotal;
      //     }, 0);

      //     // Total
      //     rpt.print("Total", { x: 370, y: startY, fontSize: 12, bold: true });
      //     rpt.print(formatCurrency(total), { x: 470, y: startY, fontSize: 12, bold: true });

      //     // Terms & Conditions Section
      //     if (quotation.terms_conditions) {
      //       rpt.print("Terms & Conditions", { x: 40, y: startY + 50, fontSize: 14, bold: true });
      //       rpt.print(quotation.terms_conditions, { x: 40, y: startY + 75, fontSize: 12 });
      //     }

      //     // Validity Information Section
      //     rpt.print("Validity Information", { x: 40, y: startY + 115, fontSize: 14, bold: true });

      //     rpt.print("Valid Until", { x: 40, y: startY + 140, fontSize: 10, color: "gray" });
      //     rpt.print(formatDate(quotation.valid_until) + " (Expired)", { x: 40, y: startY + 155, fontSize: 12, color: "red" });

      //     if (quotation.status_keterangan) {
      //       rpt.print("Status Keterangan", { x: 40, y: startY + 175, fontSize: 10, color: "gray" });
      //       rpt.print(quotation.status_keterangan, { x: 40, y: startY + 190, fontSize: 12 });
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
      //   res.setHeader("Content-Disposition", `attachment; filename=${formattedQuotationNumber}.pdf`);
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
