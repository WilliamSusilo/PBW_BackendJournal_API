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

  const getUserRole = async (supabase) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();

    return profile?.role;
  };

  try {
    switch (action) {
      // Add Asset Endpoint
      case "addAsset": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addAsset." });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ error: true, message: "No authorization header provided" });

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        // For least privillage feature
        const role = await getUserRole(supabase);
        if (role !== "user") {
          return res.status(403).json({ error: true, message: "Only user is allowed to add new asset." });
        }

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
        // const allowedRoles = ["accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { asset_type, asset_name, model, assigned_to, department, purchase_date, purchase_price, warranty_deadline, manufacturer, serial_number } = body;

        // Validasi input wajib
        if (!asset_type || !asset_name || !assigned_to || !department || !purchase_date || !purchase_price) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const requestDate = new Date(purchase_date);
        const year = requestDate.getFullYear();
        const start = parseInt(`${year}000`);
        const end = parseInt(`${year}999`);

        // Fetch latest asset number
        const { data: latestAsset, error: fetchError } = await supabase.from("assets").select("asset_tag").gte("asset_tag", start).lte("asset_tag", end).order("asset_tag", { ascending: false }).limit(1);
        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest asset tag: " + fetchError.message });
        }

        // Determine the next counter based on latest request
        let counter = 1;
        if (latestAsset && latestAsset.length > 0) {
          const lastTag = latestAsset[0].asset_tag.toString();
          const lastCounter = parseInt(lastTag.slice(4), 10);
          counter = lastCounter + 1;
        }

        // Combine prefix + counter
        const asset_tag = `${year}${String(counter).padStart(3, "0")}`;

        const { error: insertError } = await supabase.from("assets").insert([
          {
            user_id: user.id,
            asset_tag,
            asset_type,
            asset_name,
            model,
            assigned_to,
            department,
            purchase_date,
            purchase_price,
            warranty_deadline,
            manufacturer,
            serial_number,
            status: "Active",
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to add asset: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Asset added successfully" });
      }

      // Edit Asset Endpoint
      case "editAsset": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editAsset." });
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
        // const allowedRoles = ["accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, asset_type, asset_name, model, assigned_to, department, purchase_date, purchase_price, warranty_deadline, manufacturer, serial_number } = body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Asset ID is required for editing" });
        }

        const { data: existingAsset, error: fetchError } = await supabase.from("assets").select("id").eq("id", id);

        if (fetchError || !existingAsset || existingAsset.length === 0) {
          return res.status(404).json({ error: true, message: "Asset not found" });
        }

        const { error: updateError } = await supabase
          .from("assets")
          .update({
            asset_type,
            asset_name,
            model,
            assigned_to,
            department,
            purchase_date,
            purchase_price,
            warranty_deadline,
            manufacturer,
            serial_number,
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update asset: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Asset updated successfully" });
      }

      // Delete Asset Endpoint
      case "deleteAsset": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use DELETE for deleteAsset." });
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
        // const allowedRoles = ["accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id } = req.body;

        if (!id) return res.status(400).json({ error: true, message: "Asset ID is required" });

        const { data: asset, error: fetchError } = await supabase.from("assets").select("id").eq("id", id);

        if (fetchError || !asset || asset.length === 0) {
          return res.status(404).json({ error: true, message: "Asset not found" });
        }

        const { error: deleteError } = await supabase.from("assets").delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: "Failed to delete asset: " + deleteError.message });
        }

        return res.status(200).json({ error: false, message: "Asset deleted successfully" });
      }

      // Get All Assets Endpoint
      case "getAssets": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getAssets." });
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
        // const allowedRoles = ["accounting", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("assets").select("*").eq("status", "Active").order("created_at", { ascending: false }).range(from, to);

        if (search) {
          const stringColumns = ["asset_type", "asset_name", "model", "assigned_to", "department", "manufacturer", "serial_number"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("asset_tag.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("purchase_price.eq." + parseFloat(search));
          }

          const codeMatch = search.match(/^AST-?0*(\d{6,})$/i);
          if (codeMatch) {
            const extractedNumber = parseInt(codeMatch[1], 10);
            if (!isNaN(extractedNumber)) {
              eqIntConditions.push("asset_tag.eq." + extractedNumber);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch assets: " + fetchError.message });
        }

        const formattedData = data.map((item) => {
          return {
            ...item,
            asset_tag: item.asset_tag ? `AST-${item.asset_tag}` : null,
          };
        });

        return res.status(200).json({ error: false, data: formattedData });
      }

      // Sell Asset Endpoint
      case "sellAsset": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for sellAsset." });
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
        // const allowedRoles = ["finance", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, sale_date, sale_price, sold_to, reason_for_sale, invoice_no, notes } = body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required field: id" });
        }

        const { data: asset, error: fetchError } = await supabase.from("assets").select("id").eq("id", id).single();

        if (fetchError || !asset) {
          return res.status(404).json({ error: true, message: "Asset with provided ID not found" });
        }

        const { error: updateError } = await supabase
          .from("assets")
          .update({
            status: "Sold",
            sale_date,
            sale_price,
            sold_to,
            reason_for_sale,
            invoice_no,
            notes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update asset status: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Asset marked as sold successfully" });
      }

      // Get Sold Assets Endpoint
      case "getSoldAssets": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getSoldAssets." });
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

        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("assets").select("*").eq("status", "Sold").order("updated_at", { ascending: false }).range(from, to);

        if (search) {
          const stringColumns = ["asset_type", "asset_name", "model", "assigned_to", "department", "manufacturer", "serial_number", "sold_to", "reason_for_sale", "invoice_no", "notes"];
          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqIntConditions = [];
          const eqFloatConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push("asset_tag.eq." + Number(search));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqFloatConditions.push("purchase_price.eq." + parseFloat(search));
            eqFloatConditions.push("sale_price.eq." + parseFloat(search));
          }

          const codeMatch = search.match(/^AST-?0*(\d{6,})$/i);
          if (codeMatch) {
            const extractedNumber = parseInt(codeMatch[1], 10);
            if (!isNaN(extractedNumber)) {
              eqIntConditions.push("asset_tag.eq." + extractedNumber);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqFloatConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch sold assets: " + fetchError.message });
        }

        const formattedData = data.map((item) => {
          const purchase = parseFloat(item.purchase_price ?? 0);
          const sale = parseFloat(item.sale_price ?? 0);
          const profit_loss = purchase - sale;

          return {
            ...item,
            asset_tag: item.asset_tag ? `AST-${item.asset_tag}` : null,
            profit_loss,
          };
        });

        return res.status(200).json({ error: false, data: formattedData });
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
