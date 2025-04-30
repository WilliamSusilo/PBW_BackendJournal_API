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

        const { type, date, approver, due_date, status, tags, items, tax_calculation_method, ppn_percentage, pph_type, pph_percentage } = req.body;

        if (!date || !items || items.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Date and at least one item are required",
          });
        }

        // Fetch latest invoice number
        const { data: latestInvoice, error: fetchError } = await supabase.from("invoices").select("number").order("number", { ascending: true }).limit(1).single();

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest invoice number: " + fetchError.message });
        }

        let nextNumber = "1"; // default
        if (latestInvoice && latestInvoice.number !== undefined && latestInvoice.number !== null) {
          const lastNumberInt = parseInt(latestInvoice.number, 10);
          nextNumber = lastNumberInt + 1;
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
        const grand_total = dpp + ppn - pph;

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

        const { type, date, discount_terms, expiry_date, due_date, status, tags, items } = req.body;

        if (!date || !items || items.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Date and at least one item are required",
          });
        }

        // Fetch latest offer number
        const { data: latestOffer, error: fetchError } = await supabase.from("offers").select("number").order("number", { ascending: true }).limit(1).single();

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest offer number: " + fetchError.message });
        }

        let nextNumber = "1"; // default
        if (latestOffer && latestOffer.number !== undefined && latestOffer.number !== null) {
          const lastNumberInt = parseInt(latestOffer.number, 10);
          nextNumber = lastNumberInt + 1;
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
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

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

        const { type, date, orders_date, due_date, status, tags, items } = req.body;

        if (!date || !items || items.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Date and at least one item are required",
          });
        }

        // Fetch latest order number
        const { data: latestOrder, error: fetchError } = await supabase.from("orders").select("number").order("number", { ascending: true }).limit(1).single();

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest order number: " + fetchError.message });
        }

        let nextNumber = "1"; // default
        if (latestOrder && latestOrder.number !== undefined && latestOrder.number !== null) {
          const lastNumberInt = parseInt(latestOrder.number, 10);
          nextNumber = lastNumberInt + 1;
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
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

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

        const { type, date, requested_by, urgency, due_date, status, tags, items } = req.body;

        if (!date || !items || items.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Date and at least one item are required",
          });
        }

        // Fetch latest request number
        const { data: latestRequest, error: fetchError } = await supabase.from("requests").select("number").order("number", { ascending: true }).limit(1).single();

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest request number: " + fetchError.message });
        }

        let nextNumber = "1"; // default
        if (latestRequest && latestRequest.number !== undefined && latestRequest.number !== null) {
          const lastNumberInt = parseInt(latestRequest.number, 10);
          nextNumber = lastNumberInt + 1;
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
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

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

        const { type, date, tracking_number, carrier, shipping_date, due_date, status, tags, items } = req.body;

        if (!date || !items || items.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Date and at least one item are required",
          });
        }

        // Fetch latest shipment number
        const { data: latestShipment, error: fetchError } = await supabase.from("shipments").select("number").order("number", { ascending: true }).limit(1).single();

        if (fetchError && fetchError.code !== "PGRST116") {
          return res.status(500).json({ error: true, message: "Failed to fetch latest shipment number: " + fetchError.message });
        }

        let nextNumber = "1"; // default
        if (latestShipment && latestShipment.number !== undefined && latestShipment.number !== null) {
          const lastNumberInt = parseInt(latestShipment.number, 10);
          nextNumber = lastNumberInt + 1;
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
        const grand_total = updatedItems.reduce((sum, item) => sum + item.total_per_item, 0);

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

      // Delete Invoice Endpoint
      case "deleteInvoice": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteInvoice." });
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
          return res.status(400).json({
            error: true,
            message: "Invoice ID is required",
          });
        }

        // Cek apakah invoice tersebut milik user
        const { data: invoice, error: fetchError } = await supabase.from("invoices").select("id").eq("id", id);

        if (fetchError || !invoice || invoice.length === 0) {
          return res.status(404).json({
            error: true,
            message: "Invoice not found",
          });
        }

        // Hapus invoice
        const { error: deleteError } = await supabase.from("invoices").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({
            error: true,
            message: "Failed to delete invoice: " + deleteError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Invoice deleted successfully",
        });
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

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: "Offer ID is required",
          });
        }

        // Cek apakah offer tersebut milik user
        const { data: offer, error: fetchError } = await supabase.from("offers").select("id").eq("id", id);

        if (fetchError || !offer || offer.length === 0) {
          return res.status(404).json({
            error: true,
            message: "Offer not found",
          });
        }

        // Hapus offer
        const { error: deleteError } = await supabase.from("offers").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({
            error: true,
            message: "Failed to delete offer: " + deleteError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Offer deleted successfully",
        });
      }

      // Delete Order Endpoint
      case "deleteOrder": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteOrder." });
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
          return res.status(400).json({
            error: true,
            message: "Order ID is required",
          });
        }

        // Cek apakah order tersebut milik user
        const { data: order, error: fetchError } = await supabase.from("orders").select("id").eq("id", id);

        if (fetchError || !order || order.length === 0) {
          return res.status(404).json({
            error: true,
            message: "Order not found",
          });
        }

        // Hapus order
        const { error: deleteError } = await supabase.from("orders").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({
            error: true,
            message: "Failed to delete order: " + deleteError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Order deleted successfully",
        });
      }

      // Delete Request Endpoint
      case "deleteRequest": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteRequest." });
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
          return res.status(400).json({
            error: true,
            message: "Request ID is required",
          });
        }

        // Cek apakah request tersebut milik user
        const { data: request, error: fetchError } = await supabase.from("requests").select("id").eq("id", id);

        if (fetchError || !request || request.length === 0) {
          return res.status(404).json({
            error: true,
            message: "Request not found",
          });
        }

        // Hapus request
        const { error: deleteError } = await supabase.from("requests").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({
            error: true,
            message: "Failed to delete request: " + deleteError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Request deleted successfully",
        });
      }

      //   Delete Shipment Endpoint
      case "deleteShipment": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteShipment." });
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
          return res.status(400).json({
            error: true,
            message: "Shipment ID is required",
          });
        }

        // Cek apakah shipment tersebut milik user
        const { data: shipment, error: fetchError } = await supabase.from("shipments").select("id").eq("id", id);

        if (fetchError || !shipment || shipment.length === 0) {
          return res.status(404).json({
            error: true,
            message: "Shipment not found",
          });
        }

        // Hapus shipment
        const { error: deleteError } = await supabase.from("shipments").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({
            error: true,
            message: "Failed to delete shipment: " + deleteError.message,
          });
        }

        return res.status(200).json({
          error: false,
          message: "Shipment deleted successfully",
        });
      }

      // Get Invoice Endpoint
      case "getInvoice": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getInvoice." });
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

        let query = supabase.from("invoices").select("*").eq("user_id", user.id);

        if (status) query = query.eq("status", status);

        query = query.order("date", { ascending: true });

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch invoices: " + error.message });

        const formattedData = data.map((invoice) => ({
          ...invoice,
          number: `INV-${String(invoice.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Offer Endpoint
      case "getOffer": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOffer." });
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

        let query = supabase.from("offers").select("*").eq("user_id", user.id);

        if (status) query = query.eq("status", status);

        query = query.order("date", { ascending: true });

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch offers: " + error.message });

        const formattedData = data.map((offer) => ({
          ...offer,
          number: `OFR-${String(offer.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Order Endpoint
      case "getOrder": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getOrder." });
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

        let query = supabase.from("orders").select("*").eq("user_id", user.id);

        if (status) query = query.eq("status", status);

        query = query.order("date", { ascending: true });

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch orders: " + error.message });

        const formattedData = data.map((order) => ({
          ...order,
          number: `ORD-${String(order.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Get Request Endpoint
      case "getRequest": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getRequest." });
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

        let query = supabase.from("requests").select("*").eq("user_id", user.id);

        if (status) query = query.eq("status", status);

        query = query.order("date", { ascending: true });

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch requests: " + error.message });

        const formattedData = data.map((request) => ({
          ...request,
          number: `REQ-${String(request.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
      }

      //   Get Shipment Endpoint
      case "getShipment": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getShipment." });
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

        let query = supabase.from("shipments").select("*").eq("user_id", user.id);

        if (status) query = query.eq("status", status);

        query = query.order("date", { ascending: true });

        const { data, error } = await query;

        if (error) return res.status(500).json({ error: true, message: "Failed to fetch shipments: " + error.message });

        const formattedData = data.map((shipment) => ({
          ...shipment,
          number: `SH-${String(shipment.number).padStart(5, "0")}`,
        }));

        return res.status(200).json({ error: false, data: formattedData });
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

      //   let query = supabase.from("shipments").select("*").eq("user_id", user.id);

      //   if (status) query = query.eq("status", status);

      //   query = query.order("date", { ascending: true });

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
