const { getSupabaseWithToken } = require("../lib/supabaseClient");

module.exports = async (req, res) => {
  const { method, query } = req;
  const body = req.body;
  const action = method === "GET" ? query.action : body.action;

  try {
    switch (action) {
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

      // Delete Invoice, Shipment, Order, Offer, and Request Endpoint
      case "deleteInvoice":
      case "deleteShipment":
      case "deleteOrder":
      case "deleteOffer":
      case "deleteRequest": {
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

        const tableMap = {
          deleteInvoice: "invoices",
          deleteShipment: "shipments",
          deleteOrder: "orders",
          deleteOffer: "offers",
          deleteRequest: "requests",
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

      // // Get Invoice, Shipment, Order, Offer, and Request Endpoint
      // case "getInvoice":
      // case "getShipment":
      // case "getOrder":
      // case "getOffer":
      // case "getRequest": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: `Method not allowed. Use GET for ${action}.` });
      //   }

      //   const authHeader = req.headers.authorization;
      //   if (!authHeader) {
      //     return res.status(401).json({ error: true, message: "No authorization header provided" });
      //   }

      //   const token = authHeader.split(" ")[1];
      //   const supabase = getSupabaseWithToken(token);

      //   const {
      //     data: { user },
      //     error: userError,
      //   } = await supabase.auth.getUser();

      //   if (userError || !user) {
      //     return res.status(401).json({ error: true, message: "Invalid or expired token" });
      //   }

      //   const endpointsMap = new Map([
      //     ["getInvoice", { table: "invoices", prefix: "INV" }],
      //     ["getShipment", { table: "shipments", prefix: "SH" }],
      //     ["getOrder", { table: "orders", prefix: "ORD" }],
      //     ["getOffer", { table: "offers", prefix: "OFR" }],
      //     ["getRequest", { table: "requests", prefix: "REQ" }],
      //   ]);

      //   const { status } = req.query;
      //   const limit = parseInt(req.query.limit) || 10;
      //   const { table, prefix } = endpointsMap.get(action);

      //   let query = supabase.from(table).select("*");
      //   if (status) query = query.eq("status", status);
      //   query = query.order("date", { ascending: false }).limit(limit);

      //   const { data, error } = await query;

      //   if (error) {
      //     return res.status(500).json({ error: true, message: `Failed to fetch ${table}: ${error.message}` });
      //   }

      //   const formattedData = data.map((item) => ({
      //     ...item,
      //     number: `${prefix}-${String(item.number).padStart(5, "0")}`,
      //   }));

      //   return res.status(200).json({ error: false, data: formattedData });
      // }

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

        const { status } = req.query;
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("invoices").select("*").order("date", { ascending: false }).range(from, to);

        if (status) query = query.eq("status", status);

        if (search) {
          const stringColumns = ["approver"];
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

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${"INV"}-${String(item.number).padStart(5, "0")}`,
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

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch shipments: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${"SH"}-${String(item.number).padStart(5, "0")}`,
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

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch orders: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${"ORD"}-${String(item.number).padStart(5, "0")}`,
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

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch requests: " + error.message });

        const formattedData = data.map((item) => ({
          ...item,
          number: `${"REQ"}-${String(item.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Approval Endpoint
      case "getApproval": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use GET for Approval.` });
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

      // Reject Request Endpoint
      case "rejectRequest": {
        if (method !== "PATCH") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PATCH for rejectRequest." });
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
        if (!id) return res.status(400).json({ error: true, message: "Request ID is required" });

        const { data, error } = await supabase.from("requests").update({ status: "Cancelled" }).eq("id", id).select();

        if (error) return res.status(500).json({ error: true, message: "Failed to reject request: " + error.message });

        if (!data || data.length === 0) {
          return res.status(404).json({ error: true, message: "Request not found with the given ID" });
        }

        return res.status(200).json({ error: false, message: "Request rejected successfully" });
      }

      case "sendRequestToOffer": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sendRequestToOffer." });
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

        const { id } = req.body;
        if (!id) {
          return res.status(400).json({ error: true, message: "Missing Request ID" });
        }

        // 1. Get request with status "Pending"
        const { data: request, error: fetchError } = await supabase.from("requests").select("*").eq("id", id).eq("status", "Pending").single();

        if (fetchError || !request) {
          return res.status(404).json({ error: true, message: "Request not found or already completed/cancelled" });
        }

        // 2. Update the request status to "Completed"
        const { error: updateStatusError } = await supabase.from("requests").update({ status: "Completed" }).eq("id", id);

        if (updateStatusError) {
          return res.status(500).json({ error: true, message: "Failed to update request status: " + updateStatusError.message });
        }

        // 3. Generate new offer number (similar with addOffer endpoint)
        const requestDate = new Date(request.date);
        const requestMonth = requestDate.getMonth() + 1;
        const requestYear = requestDate.getFullYear();
        const prefix = `${requestYear}${String(requestMonth).padStart(2, "0")}`;
        const prefixInt = parseInt(prefix + "0", 10);
        const nextPrefixInt = parseInt(prefix + "9999", 10);

        const { data: latestOffer, error: offerError } = await supabase.from("offers").select("number").gte("number", prefixInt).lte("number", nextPrefixInt).order("number", { ascending: false }).limit(1);

        if (offerError) {
          return res.status(500).json({
            error: true,
            message: "Failed to create offer from request: " + offerError.message,
          });
        }

        let counter = 1;
        if (latestOffer && latestOffer.length > 0) {
          const lastNumber = latestOffer[0].number.toString();
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

        // 5. Insert to offers
        const { error: insertError } = await supabase.from("offers").insert([
          {
            user_id: user.id,
            type: "Offer",
            date: request.date,
            number: nextNumber,
            discount_terms: null,
            expiry_date: null,
            due_date: request.due_date,
            status: "Pending",
            tags: request.tags,
            items: updatedItems,
            grand_total,
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to insert offer: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Offer created from request successfully" });
      }

      //   Get Overdue Endpoint
      // case "getOverdue": {
      //   if (method !== "GET") {
      //     return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOverdue." });
      //   }

      //   const authHeader = req.headers.authorization;
      //   if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

      //   const token = authHeader.split(" ")[1];
      //   const supabase = getSupabaseWithToken(token);

      //   const {
      //     data: { user },
      //     error: userError,
      //   } = await supabase.auth.getUser();
      //   if (userError || !user) return res.status(401).json({ error: true, message: "Invalid or expired token" });

      //   const { status } = req.query;
      // const limit = parseInt(req.query.limit) || 10;

      //   let query = supabase.from("shipments").select("*");

      //   if (status) query = query.eq("status", status);

      //   query = query.order("date", { ascending: false }).limit(limit);

      //   const { data, error } = await query;

      //   if (error) return res.status(500).json({ error: true, message: "Failed to fetch shipments: " + error.message });

      //   const formattedData = data.map((shipment) => ({
      //     ...shipment,
      //     number: `SH-${String(shipment.number).padStart(5, "0")}`,
      //   }));

      //   return res.status(200).json({ error: false, data: formattedData });
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
