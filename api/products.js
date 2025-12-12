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

// Helper to round numeric values to 2 decimal places but keep them as numbers (not strings)
const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
// Round to 0 decimal places (integer)
const round0 = (n) => Math.round(Number(n) || 0);

// Helper to ensure warehouse exists, auto-create if not
// Supports both single string and array of warehouse names
async function ensureWarehouseExists(supabase, userId, warehouseInput) {
  // Normalize input to array
  let warehouseNames = [];

  if (typeof warehouseInput === "string") {
    warehouseNames = [warehouseInput];
  } else if (Array.isArray(warehouseInput)) {
    warehouseNames = warehouseInput.filter((name) => name && typeof name === "string");
  } else {
    return { success: false, error: "Invalid warehouse input: must be string or array of strings" };
  }

  if (warehouseNames.length === 0) {
    return { success: false, error: "No valid warehouse names provided" };
  }

  const results = [];
  const createdWarehouses = [];

  for (const warehouseName of warehouseNames) {
    // Check if warehouse already exists
    const { data: existingWarehouse, error: checkError } = await supabase.from("warehouses").select("id, name").eq("user_id", userId).eq("name", warehouseName).maybeSingle();

    if (checkError) {
      return { success: false, error: "Failed to check existing warehouse: " + checkError.message };
    }

    // If warehouse exists, add to results
    if (existingWarehouse) {
      results.push({ existed: true, warehouse: existingWarehouse });
      continue;
    }

    // Create new warehouse
    const { data: created, error: createErr } = await supabase.from("warehouses").insert({ user_id: userId, name: warehouseName, created_at: new Date() }).select("id, name").single();
    if (createErr) {
      return { success: false, error: "Failed to create warehouse: " + createErr.message };
    }
    createdWarehouses.push(created.name || warehouseName);
    results.push({ created: true, warehouse: created });
  }

  return { success: true, createdWarehouses, results };
}

module.exports = async (req, res) => {
  await runMiddleware(req, res, cors);
  const { method, query } = req;
  const body = req.body;
  const action = method === "GET" ? query.action : body.action;
  const crypto = require("crypto");

  try {
    switch (action) {
      // === ADD BILL OF MATERIAL ENDPOINT ===
      case "sendToJobDone": {
        if (method !== "POST") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for sendToJobDone.",
          });
        }

        try {
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
          if (!id) return res.status(400).json({ error: true, message: "Missing required field: id" });

          // helper
          const toNumLocal = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
          const round0Local = (v) => Math.round(toNumLocal(v));

          // Fetch WIP record
          const { data: wip, error: wipErr } = await supabase.from("work_in_process").select("*").eq("id", id).single();

          if (wipErr || !wip) return res.status(404).json({ error: true, message: "Work In Process not found" });

          const processes = Array.isArray(wip.processes) ? wip.processes : [];

          // Journal buffers
          const journalLines = [];

          // default WIP COA from record
          const wipCOA = "130102";

          // create journal header id
          const journalId = crypto && crypto.randomUUID ? crypto.randomUUID() : require("crypto").randomUUID();

          // helper to push line (will round values)
          const pushLine = (account_code, description, debit = 0, credit = 0) => {
            const d = round0Local(debit);
            const c = round0Local(credit);
            // ignore zero-zero lines
            if ((d === 0 && c === 0) || Number.isNaN(d) || Number.isNaN(c)) return;
            journalLines.push({
              journal_entry_id: journalId,
              account_code,
              description: description || "",
              debit: d,
              credit: c,
              user_id: user.id,
            });
          };

          // mapping: for each group choose the key to read from estimate and actual
          const groups = [
            { est: "direct_material", act: "direct_material_actual", estKey: "total", actKey: "total" },
            { est: "direct_labor", act: "direct_labor_actual", estKey: "total_est_rate", actKey: "total_est_rate" },
            { est: "indirect_material", act: "indirect_material_actual", estKey: "total", actKey: "total" },
            { est: "indirect_labor", act: "indirect_labor_actual", estKey: "total_est_rate", actKey: "total_est_rate" },
            { est: "items_depreciation", act: "items_depreciation_actual", estKey: "total_est_rate", actKey: "total_est_rate" },
            { est: "utilities_cost", act: "utilities_cost_actual", estKey: "total_est_rate", actKey: "total_est_rate" },
            { est: "other_foc", act: "other_foc_actual", estKey: "total_est_rate", actKey: "total_est_rate" },
          ];

          // Iterate processes
          for (const proc of processes) {
            for (const g of groups) {
              const estList = Array.isArray(proc[g.est]) ? proc[g.est] : [];
              const actList = Array.isArray(proc[g.act]) ? proc[g.act] : [];

              // compute totals (sum of est and act using appropriate keys)
              const totalEst = estList.reduce((s, it) => s + toNumLocal(it[g.estKey] || 0), 0);
              const totalAct =
                actList.length > 0
                  ? actList.reduce((s, it) => s + toNumLocal(it[g.actKey] || 0), 0)
                  : // if actual array missing, fallback: try to use estList's actual-like keys if present (defensive)
                    estList.reduce((s, it) => s + toNumLocal(it[g.actKey] || 0), 0);

              const diff = round0Local(totalAct - totalEst);
              if (diff === 0) continue; // no journaling when no difference

              const absDiff = Math.abs(diff);

              // Avoid division by zero: if totalEst === 0, distribute equally by item count (or by act values if present)
              let denomin = totalEst;
              let fallbackEqualDivide = false;
              if (denomin === 0) {
                if (actList.length > 0) {
                  denomin = actList.reduce((s, it) => s + toNumLocal(it[g.actKey] || 0), 0) || 0;
                }
                if (denomin === 0) {
                  denomin = estList.length > 0 ? estList.length : actList.length > 0 ? actList.length : 1;
                  fallbackEqualDivide = true;
                }
              }

              if (diff > 0) {
                // actual > estimate: Debit WIP, Credit items
                pushLine(wipCOA, "Work In Process", absDiff, 0);

                // Distribute credit only to items that have difference (est != act)
                // Identify targetList by matching items by name/desc
                const targetList = (estList || []).filter((it) => {
                  const key = it.item_name || it.desc || it.name || null;
                  const actMatch = (actList || []).find((a) => (a.item_name || a.desc || a.name || null) === key) || {};
                  const estVal = toNumLocal(it[g.estKey] || 0);
                  const actVal = toNumLocal(actMatch[g.actKey] || 0);
                  return estVal !== actVal;
                });

                // If nothing differs, fallback to original behavior (proportional by est)
                const finalList = targetList.length > 0 ? targetList : estList.length > 0 ? estList : actList;

                if (!finalList || finalList.length === 0) {
                  // nothing to allocate
                } else {
                  // compute denominator for finalList
                  let denomForFinal = 0;
                  if (fallbackEqualDivide) {
                    // equal split among finalList
                    const chunk = round0Local(absDiff / (finalList.length || 1));
                    for (let i = 0; i < finalList.length; i++) {
                      const it = finalList[i] || {};
                      const amount = i === finalList.length - 1 ? round0Local(absDiff - chunk * (finalList.length - 1)) : chunk;
                      pushLine(it.coa || "UNKNOWN", it.item_name || it.desc || g.est, 0, amount);
                    }
                  } else {
                    // proportional by est values within finalList
                    denomForFinal = finalList.reduce((s, it) => s + toNumLocal(it[g.estKey] || 0), 0);
                    if (denomForFinal === 0) {
                      // if denominator zero, equal split
                      const chunk = round0Local(absDiff / finalList.length);
                      for (let i = 0; i < finalList.length; i++) {
                        const it = finalList[i] || {};
                        const amount = i === finalList.length - 1 ? round0Local(absDiff - chunk * (finalList.length - 1)) : chunk;
                        pushLine(it.coa || "UNKNOWN", it.item_name || it.desc || g.est, 0, amount);
                      }
                    } else {
                      let allocated = 0;
                      for (let i = 0; i < finalList.length; i++) {
                        const it = finalList[i];
                        const estVal = toNumLocal(it[g.estKey] || 0);
                        const proportion = denomForFinal === 0 ? 0 : estVal / denomForFinal;
                        const amt = i === finalList.length - 1 ? round0Local(absDiff - allocated) : round0Local(absDiff * proportion);
                        allocated += amt;
                        pushLine(it.coa || "UNKNOWN", it.item_name || it.desc || g.est, 0, amt);
                      }
                    }
                  }
                }
              } else {
                // actual < estimate: Credit WIP, Debit items
                pushLine(wipCOA, "Work In Process", 0, absDiff);

                // Distribute debit only to items that have difference (est != act)
                const targetList = (estList || []).filter((it) => {
                  const key = it.item_name || it.desc || it.name || null;
                  const actMatch = (actList || []).find((a) => (a.item_name || a.desc || a.name || null) === key) || {};
                  const estVal = toNumLocal(it[g.estKey] || 0);
                  const actVal = toNumLocal(actMatch[g.actKey] || 0);
                  return estVal !== actVal;
                });

                const finalList = targetList.length > 0 ? targetList : estList.length > 0 ? estList : actList;

                if (!finalList || finalList.length === 0) {
                  // nothing to allocate
                } else {
                  if (fallbackEqualDivide) {
                    const chunk = round0Local(absDiff / (finalList.length || 1));
                    for (let i = 0; i < finalList.length; i++) {
                      const it = finalList[i] || {};
                      const amount = i === finalList.length - 1 ? round0Local(absDiff - chunk * (finalList.length - 1)) : chunk;
                      pushLine(it.coa || "UNKNOWN", it.item_name || it.desc || g.est, amount, 0);
                    }
                  } else {
                    const denomForFinal = finalList.reduce((s, it) => s + toNumLocal(it[g.estKey] || 0), 0);
                    if (denomForFinal === 0) {
                      const chunk = round0Local(absDiff / finalList.length);
                      for (let i = 0; i < finalList.length; i++) {
                        const it = finalList[i] || {};
                        const amount = i === finalList.length - 1 ? round0Local(absDiff - chunk * (finalList.length - 1)) : chunk;
                        pushLine(it.coa || "UNKNOWN", it.item_name || it.desc || g.est, amount, 0);
                      }
                    } else {
                      let allocated = 0;
                      for (let i = 0; i < finalList.length; i++) {
                        const it = finalList[i];
                        const estVal = toNumLocal(it[g.estKey] || 0);
                        const proportion = denomForFinal === 0 ? 0 : estVal / denomForFinal;
                        const amt = i === finalList.length - 1 ? round0Local(absDiff - allocated) : round0Local(absDiff * proportion);
                        allocated += amt;
                        pushLine(it.coa || "UNKNOWN", it.item_name || it.desc || g.est, amt, 0);
                      }
                    }
                  }
                }
              }
            } // end groups loop
          } // end processes loop

          // Build separate postings for Finished Goods, Defective Goods, and Other Expenses
          const fgLines = [];
          const pushFgLine = (account_code, description, debit = 0, credit = 0) => {
            const d = round0Local(debit);
            const c = round0Local(credit);
            if ((d === 0 && c === 0) || Number.isNaN(d) || Number.isNaN(c)) return;
            fgLines.push({
              journal_entry_id: null, // to be replaced after FG journal id created
              account_code,
              description: description || "",
              debit: d,
              credit: c,
              user_id: user.id,
            });
          };

          try {
            const cogmPerUnit = toNumLocal(wip.cogm_per_unit_actual || wip.cogm_per_unit || 0);
            const totalFinished = toNumLocal(wip.total_finished_goods || 0);
            const totalDefective = toNumLocal(wip.total_defective_goods || 0);
            const prodLoss = toNumLocal(wip.prod_loss || 0);
            const totalExpenses = toNumLocal(wip.total_expenses || wip.total_expenses_actual || 0);

            // Finished Goods
            const amtFinished = round0Local(cogmPerUnit * totalFinished);
            if (amtFinished > 0) {
              // Debit Finished Goods (130103), Credit Work In Process (130102)
              pushFgLine("130103", "Finished Goods", amtFinished, 0);
              pushFgLine("130102", "Work In Process", 0, amtFinished);
            }

            // Defective Goods
            const amtDefective = round0Local(cogmPerUnit * totalDefective);
            if (amtDefective > 0) {
              // Debit Defective Product (130104), Credit Work In Process (130102)
              pushFgLine("130104", "Defective Product", amtDefective, 0);
              pushFgLine("130102", "Work In Process", 0, amtDefective);
            }

            // Other Expenses
            const amtOtherExpenses = round0Local(prodLoss * totalExpenses);
            if (amtOtherExpenses > 0) {
              // Debit Other Expenses (500101-9), Credit Work In Process (130102)
              pushFgLine("500101-9", "Other Expenses", amtOtherExpenses, 0);
              pushFgLine("130102", "Work In Process", 0, amtOtherExpenses);
            }
          } catch (eAddPosting) {
            console.error("Failed to compute additional postings for JobDone:", eAddPosting);
          }

          // If nothing to journal at all
          if (journalLines.length === 0 && fgLines.length === 0) {
            return res.status(200).json({ error: false, message: "No differences found — nothing to journal." });
          }

          // Create variance journal (if any variance lines exist)
          let createdVarianceJournal = null;
          let insertedVarianceLines = null;
          if (journalLines.length > 0) {
            const { data: journalCreated, error: journalCreateErr } = await supabase
              .from("journal_entries")
              .insert([
                {
                  id: journalId,
                  transaction_number: `JOBDONE-${id}`,
                  description: `Job Done Journal for WIP ${id}`,
                  user_id: user.id,
                  entry_date: new Date().toISOString().split("T")[0],
                  created_at: new Date(),
                },
              ])
              .select()
              .single();

            if (journalCreateErr) {
              console.error("journal create err", journalCreateErr);
              return res.status(500).json({ error: true, message: "Failed to create journal entry: " + journalCreateErr.message });
            }

            // Insert variance lines and capture inserted rows
            const { data: insertedLines, error: linesErr } = await supabase.from("journal_entry_lines").insert(journalLines).select();
            if (linesErr) {
              console.error("journal lines err", linesErr);
              await supabase.from("journal_entries").delete().eq("id", journalId);
              return res.status(500).json({ error: true, message: "Failed to insert journal lines: " + linesErr.message });
            }

            createdVarianceJournal = journalCreated || null;
            insertedVarianceLines = insertedLines || [];
          }

          // Create Finished Goods / Defective / Other Expenses journal (separate) if any
          let createdFgJournal = null;
          let insertedFgLines = null;
          if (fgLines.length > 0) {
            const fgJournalId = crypto && crypto.randomUUID ? crypto.randomUUID() : require("crypto").randomUUID();
            const { data: fgJournalCreated, error: fgJournalErr } = await supabase
              .from("journal_entries")
              .insert([
                {
                  id: fgJournalId,
                  transaction_number: `FINISHEDGOODS-${id}`,
                  description: `Finished Goods Journal for WIP ${id}`,
                  user_id: user.id,
                  entry_date: new Date().toISOString().split("T")[0],
                  created_at: new Date(),
                },
              ])
              .select()
              .single();

            if (fgJournalErr) {
              console.error("fg journal create err", fgJournalErr);
              // rollback variance journal if we created it
              if (createdVarianceJournal && createdVarianceJournal.id) await supabase.from("journal_entries").delete().eq("id", createdVarianceJournal.id);
              return res.status(500).json({ error: true, message: "Failed to create Finished Goods journal entry: " + fgJournalErr.message });
            }

            // assign fgJournalId to lines and insert, capture inserted rows
            const fgToInsert = fgLines.map((ln) => ({ ...ln, journal_entry_id: fgJournalId }));
            const { data: fgInserted, error: fgLinesErr } = await supabase.from("journal_entry_lines").insert(fgToInsert).select();
            if (fgLinesErr) {
              console.error("fg journal lines err", fgLinesErr);
              // rollback both journals if needed
              await supabase.from("journal_entries").delete().eq("id", fgJournalId);
              if (createdVarianceJournal && createdVarianceJournal.id) await supabase.from("journal_entries").delete().eq("id", createdVarianceJournal.id);
              return res.status(500).json({ error: true, message: "Failed to insert Finished Goods journal lines: " + fgLinesErr.message });
            }

            createdFgJournal = fgJournalCreated || null;
            insertedFgLines = fgInserted || [];
          }

          // -----------------------------
          // Update stock quantities for direct_material and indirect_material
          // -----------------------------
          const stockAdjustments = {}; // coa -> totalQty
          try {
            // accumulate qty from processes (direct_material + indirect_material)
            for (const proc of processes) {
              const dm = Array.isArray(proc.direct_material) ? proc.direct_material : [];
              const im = Array.isArray(proc.indirect_material) ? proc.indirect_material : [];
              for (const it of dm.concat(im)) {
                const coa = it && it.coa ? String(it.coa) : null;
                const qty = it && (it.qty !== undefined ? Number(it.qty) : Number(it.qty || 0)) ? Number(it.qty || 0) : 0;
                if (!coa) continue;
                if (!stockAdjustments[coa]) stockAdjustments[coa] = 0;
                stockAdjustments[coa] += qty;
              }
            }

            const stockUpdates = [];
            for (const [coa, qtyToDeduct] of Object.entries(stockAdjustments)) {
              if (!qtyToDeduct || qtyToDeduct === 0) continue;
              // Find stock items matching this COA for the user
              const { data: stocks, error: stockFetchErr } = await supabase.from("stock").select("id,stock_COA,current_stock").eq("stock_COA", coa).eq("user_id", user.id);
              if (stockFetchErr) {
                console.error("Failed to fetch stock for COA", coa, stockFetchErr);
                // rollback journals if any created
                if (createdFgJournal && createdFgJournal.id) await supabase.from("journal_entries").delete().eq("id", createdFgJournal.id);
                if (createdVarianceJournal && createdVarianceJournal.id) await supabase.from("journal_entries").delete().eq("id", createdVarianceJournal.id);
                return res.status(500).json({ error: true, message: "Failed to fetch stock for COA: " + coa + " - " + stockFetchErr.message });
              }

              if (!stocks || stocks.length === 0) continue; // nothing to update

              // If multiple stock records match, distribute deduction proportionally by current_stock (or equally if zeros)
              let totalAvailable = stocks.reduce((s, r) => s + (Number(r.current_stock) || 0), 0);
              if (totalAvailable === 0) totalAvailable = stocks.length;

              let allocated = 0;
              for (let i = 0; i < stocks.length; i++) {
                const srec = stocks[i];
                let portion = 0;
                if (i === stocks.length - 1) {
                  portion = qtyToDeduct - allocated; // remainder
                } else {
                  const weight = Number(srec.current_stock) || 0;
                  portion = Math.round((weight / totalAvailable) * qtyToDeduct) || 0;
                }
                allocated += portion;
                const before = Number(srec.current_stock) || 0;
                const after = before - portion;
                const { error: updateErr } = await supabase.from("stock").update({ current_stock: after, updated_at: new Date().toISOString() }).eq("id", srec.id);
                if (updateErr) {
                  console.error("Failed to update stock id", srec.id, updateErr);
                  // rollback journals if any created
                  if (createdFgJournal && createdFgJournal.id) await supabase.from("journal_entries").delete().eq("id", createdFgJournal.id);
                  if (createdVarianceJournal && createdVarianceJournal.id) await supabase.from("journal_entries").delete().eq("id", createdVarianceJournal.id);
                  return res.status(500).json({ error: true, message: "Failed to update stock for COA: " + coa + " - " + updateErr.message });
                }
                stockUpdates.push({ stock_id: srec.id, stock_COA: coa, before, after, deducted: portion });
              }
            }

            return res.status(200).json({
              error: false,
              message: "JobDone journaling created successfully",
              variance_journal: createdVarianceJournal,
              variance_lines: insertedVarianceLines,
              finished_goods_journal: createdFgJournal,
              finished_goods_lines: insertedFgLines,
              stock_updates: stockUpdates,
            });
          } catch (stockErr) {
            console.error("Stock update error:", stockErr);
            // rollback journals if any created
            if (createdFgJournal && createdFgJournal.id) await supabase.from("journal_entries").delete().eq("id", createdFgJournal.id);
            if (createdVarianceJournal && createdVarianceJournal.id) await supabase.from("journal_entries").delete().eq("id", createdVarianceJournal.id);
            return res.status(500).json({ error: true, message: "Stock update error: " + (stockErr && stockErr.message ? stockErr.message : stockErr) });
          }
        } catch (err) {
          console.error("sendToJobDone error", err);
          return res.status(500).json({ error: true, message: "Internal server error in sendToJobDone" });
        }
      }
      case "addBillOfMaterial": {
        if (method !== "POST") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use POST for addBillOfMaterial.",
          });
        }

        const authHeader = req.headers.authorization;
        if (!authHeader) {
          return res.status(401).json({ error: true, message: "No authorization header provided" });
        }

        const token = authHeader.split(" ")[1];
        const supabase = getSupabaseWithToken(token);

        // === GET USER ===
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();
        if (userError || !user) {
          return res.status(401).json({ error: true, message: "Invalid or expired token" });
        }

        // === BODY INPUT ===
        const { bom_name, sku, qty_goods_est, category, est_compl_time, job_order_product, processes = [] } = req.body;

        // === VALIDATION ===
        if (!bom_name || !sku || qty_goods_est === undefined || !category || !est_compl_time || !Array.isArray(processes) || processes.length === 0) {
          return res.status(400).json({
            error: true,
            message: "Missing required fields or empty processes array",
          });
        }

        // Helpers to ensure numeric ops are safe
        const toNum = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
        const safeDiv = (num, den) => (toNum(den) ? toNum(num) / toNum(den) : 0);

        // ============================
        //  PROCESS EACH PROCESS IN ARRAY
        // ============================
        const processedProcesses = processes.map((proc) => {
          const { process_name, job_desc, direct_material = [], direct_labor = [], indirect_material = [], indirect_labor = [], items_depreciation = [], utilities_cost = [], other_foc = [] } = proc;

          // 1. DIRECT MATERIAL
          const calcDirectMaterial = (Array.isArray(direct_material) ? direct_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_direct_material = calcDirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 2. DIRECT LABOR
          const calcDirectLabor = (Array.isArray(direct_labor) ? direct_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_direct_labor = calcDirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 3. INDIRECT MATERIAL
          const calcIndirectMaterial = (Array.isArray(indirect_material) ? indirect_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_indirect_material = calcIndirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 4. INDIRECT LABOR
          const calcIndirectLabor = (Array.isArray(indirect_labor) ? indirect_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_indirect_labor = calcIndirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 5. ITEMS DEPRECIATION
          const calcItemsDep = (Array.isArray(items_depreciation) ? items_depreciation : []).map((i) => {
            const book_value = toNum(i.qty) * toNum(i.price) - toNum(i.acc_dep);
            const est_useful_total = toNum(i.operatingday_per_month) * toNum(i.operatinghours_per_day) * 12 * toNum(i.est_useful);
            const dep_per_hours = safeDiv(book_value - toNum(i.salvage_value), est_useful_total);
            const rate_estimated = dep_per_hours * toNum(i.order_compl_time);
            return { ...i, book_value, est_useful_total, dep_per_hours, rate_estimated };
          });
          const total_items_depreciation = calcItemsDep.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 6. UTILITIES COST
          const calcUtilities = (Array.isArray(utilities_cost) ? utilities_cost : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_utilities_cost = calcUtilities.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 7. OTHER FOC
          const calcOtherFOC = (Array.isArray(other_foc) ? other_foc : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_other_foc = calcOtherFOC.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // PROCESS TOTALS
          const process_total_foc = toNum(total_indirect_material) + toNum(total_indirect_labor) + toNum(total_items_depreciation) + toNum(total_utilities_cost) + toNum(total_other_foc);
          const process_total_cogm = toNum(total_direct_material) + toNum(total_direct_labor) + toNum(process_total_foc);

          return {
            process_name,
            job_desc,
            direct_material: calcDirectMaterial,
            direct_labor: calcDirectLabor,
            indirect_material: calcIndirectMaterial,
            indirect_labor: calcIndirectLabor,
            items_depreciation: calcItemsDep,
            utilities_cost: calcUtilities,
            other_foc: calcOtherFOC,
            total_direct_material,
            total_direct_labor,
            total_indirect_material,
            total_indirect_labor,
            total_items_depreciation,
            total_utilities_cost,
            total_other_foc,
            process_total_foc,
            process_total_cogm,
          };
        });

        // ============================
        //  AGGREGATE TOTALS FROM ALL PROCESSES
        // ============================
        const total_foc_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_foc), 0);
        const total_cogm_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_cogm), 0);
        const cogm_unit_est = safeDiv(total_cogm_est, toNum(qty_goods_est));

        // Additional BOM-level aggregates per cost category (sum of all processes)
        const agg_total_direct_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_material), 0);
        const agg_total_direct_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_labor), 0);
        const agg_total_indirect_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_material), 0);
        const agg_total_indirect_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_labor), 0);
        const agg_total_items_depreciation = processedProcesses.reduce((sum, p) => sum + toNum(p.total_items_depreciation), 0);
        const agg_total_utilities_cost = processedProcesses.reduce((sum, p) => sum + toNum(p.total_utilities_cost), 0);
        const agg_total_other_foc = processedProcesses.reduce((sum, p) => sum + toNum(p.total_other_foc), 0);

        // ============================
        //  INSERT TO DATABASE
        // ============================
        const { error: insertErr } = await supabase.from("bill_of_material").insert([
          {
            user_id: user.id,
            bom_name,
            sku,
            qty_goods_est: toNum(qty_goods_est),
            category,
            est_compl_time: toNum(est_compl_time),
            job_order_product: !!job_order_product,
            processes: processedProcesses,
            total_foc_est,
            total_cogm_est,
            cogm_unit_est,
            total_direct_material: round2(agg_total_direct_material),
            total_direct_labor: round2(agg_total_direct_labor),
            total_indirect_material: round2(agg_total_indirect_material),
            total_indirect_labor: round2(agg_total_indirect_labor),
            total_items_depreciation: round2(agg_total_items_depreciation),
            total_utilities_cost: round2(agg_total_utilities_cost),
            total_other_foc: round2(agg_total_other_foc),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ]);

        if (insertErr) {
          return res.status(500).json({
            error: true,
            message: "Failed to insert Bill of Material: " + insertErr.message,
          });
        }
        // If this BOM is used to create a product for job order, insert Product instead
        if (job_order_product === true || job_order_product === "true") {
          const { error: insertProductError } = await supabase.from("products").insert([
            {
              user_id: user.id,
              name: bom_name,
              sku,
              category,
              created_at: new Date().toISOString(),
            },
          ]);

          if (insertProductError) {
            return res.status(500).json({ error: true, message: "Failed to create product from BOM: " + insertProductError.message });
          }
        }

        // Otherwise create a production_plan derived from this BOM
        else {
          try {
            const mappedProcesses = processedProcesses.map((p) => ({
              process_name: p.process_name,
              job_desc: p.job_desc,
              direct_material: (p.direct_material || []).map((i) => ({
                coa: i.coa ?? null,
                item_name: i.item_name ?? i.name ?? null,
                desc: i.desc ?? null,
                qty: Number(i.qty) || 0,
                unit: i.unit ?? null,
                price: Number(i.price) || 0,
              })),
              direct_labor: (p.direct_labor || []).map((i) => ({
                coa: i.coa ?? null,
                item_name: i.item_name ?? i.name ?? null,
                desc: i.desc ?? null,
                qty: Number(i.qty) || 0,
                unit: i.unit ?? null,
                order_compl_time: Number(i.order_compl_time) || 0,
                rate_per_hours: Number(i.rate_per_hours) || 0,
              })),
              indirect_material: (p.indirect_material || []).map((i) => ({
                coa: i.coa ?? null,
                item_name: i.item_name ?? i.name ?? null,
                desc: i.desc ?? null,
                qty: Number(i.qty) || 0,
                unit: i.unit ?? null,
                price: Number(i.price) || 0,
              })),
              indirect_labor: (p.indirect_labor || []).map((i) => ({
                coa: i.coa ?? null,
                item_name: i.item_name ?? i.name ?? null,
                desc: i.desc ?? null,
                qty: Number(i.qty) || 0,
                unit: i.unit ?? null,
                order_compl_time: Number(i.order_compl_time) || 0,
                rate_per_hours: Number(i.rate_per_hours) || 0,
              })),
              items_depreciation: (p.items_depreciation || []).map((i) => ({
                coa: i.coa ?? null,
                item_name: i.item_name ?? i.name ?? null,
                desc: i.desc ?? null,
                qty: Number(i.qty) || 0,
                unit: i.unit ?? null,
                rate_estimated: Number(i.rate_estimated) || 0,
              })),
              utilities_cost: (p.utilities_cost || []).map((i) => ({
                coa: i.coa ?? null,
                item_name: i.item_name ?? i.name ?? null,
                desc: i.desc ?? null,
                unit: i.unit ?? null,
                est_qty: Number(i.est_qty) || 0,
                price: Number(i.price) || 0,
              })),
              other_foc: (p.other_foc || []).map((i) => ({
                coa: i.coa ?? null,
                item_name: i.item_name ?? i.name ?? null,
                desc: i.desc ?? null,
                unit: i.unit ?? null,
                price: Number(i.price) || 0,
                est_qty: Number(i.est_qty) || 0,
              })),
            }));

            const { error: insertPlanErr } = await supabase.from("production_plan").insert([
              {
                user_id: user.id,
                product_name: bom_name,
                sku,
                qty_goods_est: Number(qty_goods_est) || 0,
                category,
                processes: mappedProcesses,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
            ]);

            if (insertPlanErr) {
              return res.status(500).json({ error: true, message: "Failed to create production plan: " + insertPlanErr.message });
            }
          } catch (err) {
            return res.status(500).json({ error: true, message: "Failed to create production plan: " + err.message });
          }
        }

        return res.status(201).json({
          error: false,
          message: "Bill of Material added successfully",
          data: {
            bom_name,
            total_foc_est: round2(total_foc_est),
            total_cogm_est: round2(total_cogm_est),
            cogm_unit_est: round2(cogm_unit_est),
          },
        });
      }

      // Add Stock Endpoint
      case "addStock": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addStock." });
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

        const { name, sku, category, unit, minimum_stock, warehouses, stock_COA, description, copyToProduct = false } = req.body;

        if (!name || !sku || !category || !unit || minimum_stock === undefined || !warehouses || !stock_COA || !description) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        // Auto-create warehouse(s) if they don't exist
        const warehouseResult = await ensureWarehouseExists(supabase, user.id, warehouses);
        if (!warehouseResult.success) {
          return res.status(500).json({ error: true, message: warehouseResult.error });
        }

        // Insert new stock
        const { error: insertStockError, data: insertedStock } = await supabase
          .from("stock")
          .insert([
            {
              user_id: user.id,
              name,
              sku,
              category,
              unit,
              minimum_stock: Number(minimum_stock),
              warehouses,
              stock_COA,
              description,
              copyToProduct,
              created_at: new Date().toISOString(),
            },
          ])
          .select("*")
          .single();

        if (insertStockError) {
          return res.status(500).json({ error: true, message: "Failed to add stock: " + insertStockError.message });
        }

        // Update total_stock for all affected warehouses
        await updateWarehouseTotalStock(supabase, user.id, warehouses);

        // Build response message
        let responseMessage = "Stock added successfully";
        if (warehouseResult.createdWarehouses && warehouseResult.createdWarehouses.length > 0) {
          const createdList = warehouseResult.createdWarehouses.map((w) => `"${w}"`).join(", ");
          responseMessage += ` (Warehouse${warehouseResult.createdWarehouses.length > 1 ? "s" : ""} ${createdList} auto-created)`;
        }

        // Only insert to products if copyToProduct = true
        if (copyToProduct === true) {
          // Get the latest total_cogs data from inventory
          const { data: latestInventory, error: inventoryError } = await supabase.from("inventory").select("total_cogs").order("updated_at", { ascending: false }).limit(1).single();

          if (inventoryError) {
            return res.status(404).json({ error: true, message: "Total COGS data not found" });
          }

          const { error: insertProductError } = await supabase.from("products").insert([
            {
              user_id: user.id,
              name,
              sku,
              category,
              unit,
              warehouses,
              company_type: "Merchandise or Manufacturing",
              items_product: {
                stock_COA,
                stock_name: name,
                sell_price: null,
                cogs: latestInventory?.total_cogs || 0,
              },
              created_at: new Date().toISOString(),
            },
          ]);

          if (insertProductError) {
            return res.status(500).json({ error: true, message: "Failed to insert data to product: " + insertProductError.message });
          }
        }

        return res.status(201).json({ error: false, message: responseMessage, data: { id: insertedStock.id } });
      }

      // === EDIT BILL OF MATERIAL ENDPOINT ===
      case "editBillOfMaterial": {
        if (method !== "PUT") {
          return res.status(405).json({
            error: true,
            message: "Method not allowed. Use PUT for editBillOfMaterial.",
          });
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

        const { id, bom_name, sku, qty_goods_est, category, est_compl_time, job_order_product, processes = [] } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required field: id" });
        }

        const toNum = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
        const safeDiv = (num, den) => (toNum(den) ? toNum(num) / toNum(den) : 0);

        // ============================
        //  PROCESS EACH PROCESS IN ARRAY
        // ============================
        const processedProcesses = processes.map((proc) => {
          const { process_name, job_desc, direct_material = [], direct_labor = [], indirect_material = [], indirect_labor = [], items_depreciation = [], utilities_cost = [], other_foc = [] } = proc;

          // 1. DIRECT MATERIAL
          const calcDirectMaterial = (Array.isArray(direct_material) ? direct_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_direct_material = calcDirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 2. DIRECT LABOR
          const calcDirectLabor = (Array.isArray(direct_labor) ? direct_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_direct_labor = calcDirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 3. INDIRECT MATERIAL
          const calcIndirectMaterial = (Array.isArray(indirect_material) ? indirect_material : []).map((item) => ({
            ...item,
            qty: toNum(item.qty),
            price: toNum(item.price),
            total: toNum(item.qty) * toNum(item.price),
          }));
          const total_indirect_material = calcIndirectMaterial.reduce((sum, i) => sum + toNum(i.total), 0);

          // 4. INDIRECT LABOR
          const calcIndirectLabor = (Array.isArray(indirect_labor) ? indirect_labor : []).map((i) => {
            const rate_per_day = safeDiv(toNum(i.rate_per_month), toNum(i.workday_per_month));
            const rate_per_hours = safeDiv(rate_per_day, toNum(i.workhours_per_day));
            const rate_estimated = rate_per_hours * toNum(i.order_compl_time) * toNum(i.qty);
            return { ...i, rate_per_day, rate_per_hours, rate_estimated };
          });
          const total_indirect_labor = calcIndirectLabor.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 5. ITEMS DEPRECIATION
          const calcItemsDep = (Array.isArray(items_depreciation) ? items_depreciation : []).map((i) => {
            const book_value = toNum(i.qty) * toNum(i.price) - toNum(i.acc_dep);
            const est_useful_total = toNum(i.operatingday_per_month) * toNum(i.operatinghours_per_day) * 12 * toNum(i.est_useful);
            const dep_per_hours = safeDiv(book_value - toNum(i.salvage_value), est_useful_total);
            const rate_estimated = dep_per_hours * toNum(i.order_compl_time);
            return { ...i, book_value, est_useful_total, dep_per_hours, rate_estimated };
          });
          const total_items_depreciation = calcItemsDep.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 6. UTILITIES COST
          const calcUtilities = (Array.isArray(utilities_cost) ? utilities_cost : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_utilities_cost = calcUtilities.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // 7. OTHER FOC
          const calcOtherFOC = (Array.isArray(other_foc) ? other_foc : []).map((i) => {
            const total = toNum(i.qty) * toNum(i.price);
            const est_per_day = safeDiv(total, toNum(i.operating_day));
            const est_per_hours = safeDiv(est_per_day, toNum(i.operatinghours_per_day));
            const est_qty = safeDiv(safeDiv(toNum(i.qty), toNum(i.operating_day)), toNum(i.operatinghours_per_day)) * toNum(i.order_compl_time);
            const rate_estimated = est_per_hours * toNum(i.order_compl_time);
            return { ...i, total, est_per_day, est_per_hours, est_qty, rate_estimated };
          });
          const total_other_foc = calcOtherFOC.reduce((sum, i) => sum + toNum(i.rate_estimated), 0);

          // PROCESS TOTALS
          const process_total_foc = toNum(total_indirect_material) + toNum(total_indirect_labor) + toNum(total_items_depreciation) + toNum(total_utilities_cost) + toNum(total_other_foc);
          const process_total_cogm = toNum(total_direct_material) + toNum(total_direct_labor) + toNum(process_total_foc);

          return {
            process_name,
            job_desc,
            direct_material: calcDirectMaterial,
            direct_labor: calcDirectLabor,
            indirect_material: calcIndirectMaterial,
            indirect_labor: calcIndirectLabor,
            items_depreciation: calcItemsDep,
            utilities_cost: calcUtilities,
            other_foc: calcOtherFOC,
            total_direct_material,
            total_direct_labor,
            total_indirect_material,
            total_indirect_labor,
            total_items_depreciation,
            total_utilities_cost,
            total_other_foc,
            process_total_foc,
            process_total_cogm,
          };
        });

        // ============================
        //  AGGREGATE TOTALS FROM ALL PROCESSES
        // ============================
        const total_foc_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_foc), 0);
        const total_cogm_est = processedProcesses.reduce((sum, p) => sum + toNum(p.process_total_cogm), 0);
        const cogm_unit_est = safeDiv(total_cogm_est, toNum(qty_goods_est));

        // Additional BOM-level aggregates per cost category (sum of all processes)
        const agg_total_direct_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_material), 0);
        const agg_total_direct_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_direct_labor), 0);
        const agg_total_indirect_material = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_material), 0);
        const agg_total_indirect_labor = processedProcesses.reduce((sum, p) => sum + toNum(p.total_indirect_labor), 0);
        const agg_total_items_depreciation = processedProcesses.reduce((sum, p) => sum + toNum(p.total_items_depreciation), 0);
        const agg_total_utilities_cost = processedProcesses.reduce((sum, p) => sum + toNum(p.total_utilities_cost), 0);
        const agg_total_other_foc = processedProcesses.reduce((sum, p) => sum + toNum(p.total_other_foc), 0);

        const { error: updateErr } = await supabase
          .from("bill_of_material")
          .update({
            user_id: user.id,
            bom_name,
            sku,
            qty_goods_est: toNum(qty_goods_est),
            category,
            est_compl_time: toNum(est_compl_time),
            job_order_product: !!job_order_product,
            processes: processedProcesses,
            total_foc_est,
            total_cogm_est,
            cogm_unit_est,
            total_direct_material: round2(agg_total_direct_material),
            total_direct_labor: round2(agg_total_direct_labor),
            total_indirect_material: round2(agg_total_indirect_material),
            total_indirect_labor: round2(agg_total_indirect_labor),
            total_items_depreciation: round2(agg_total_items_depreciation),
            total_utilities_cost: round2(agg_total_utilities_cost),
            total_other_foc: round2(agg_total_other_foc),
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateErr) {
          return res.status(500).json({ error: true, message: "Failed to update Bill of Material: " + updateErr.message });
        }

        return res.status(200).json({
          error: false,
          message: "Bill of Material updated successfully",
          data: {
            id,
            bom_name,
            total_foc_est: round2(total_foc_est),
            total_cogm_est: round2(total_cogm_est),
            cogm_unit_est: round2(cogm_unit_est),
          },
        });
      }
      // Add Product Endpoint
      case "addProduct": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addProduct." });
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
        // const allowedRoles = ["inventory", "procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        // Accept new fields: acc_info (text) and items_product (jsonb). For backward compatibility,
        // if items_product is not provided, build it from legacy fields: stock_COA, stock_name, sell_price, cogs.
        const {
          category,
          name,
          unit,
          sku,
          warehouses,
          description,
          sales_COA,
          cogs_COA,
          items_product,
          // legacy fields (optional, used to construct items_product if items_product not provided)
          stock_COA,
          stock_name,
          sell_price,
          cogs,
        } = req.body;

        if (!category || !name || !unit || !sku || !warehouses || !description || !sales_COA || !cogs_COA) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const itemsProductPayload =
          items_product && typeof items_product === "object"
            ? {
                stock_COA: items_product.stock_COA ?? null,
                stock_name: items_product.stock_name ?? null,
                sell_price: items_product.sell_price != null ? Number(items_product.sell_price) : null,
                cogs: items_product.cogs != null ? Number(items_product.cogs) : null,
              }
            : {
                stock_COA: stock_COA ?? null,
                stock_name: stock_name ?? null,
                sell_price: sell_price != null ? Number(sell_price) : null,
                cogs: cogs != null ? Number(cogs) : null,
              };

        // Ensure all required items_product fields are present (not null/undefined)
        const requiredItemKeys = ["stock_COA", "stock_name", "sell_price", "cogs"];
        const hasAllItemFields = requiredItemKeys.every((k) => itemsProductPayload[k] !== null && itemsProductPayload[k] !== undefined);
        if (!hasAllItemFields) {
          return res.status(400).json({ error: true, message: "Missing required items_product fields (stock_COA, stock_name, sell_price, cogs)" });
        }

        // const allowedStatuses = ["In Stock", "Out of Stock"];
        // if (!allowedStatuses.includes(status)) {
        //   return res.status(400).json({ error: true, message: `Invalid status. Allowed values: ${allowedStatuses.join(", ")}` });
        // }

        // const { data: maxNumberData, error: fetchError } = await supabase.from("products").select("number").order("number", { ascending: false }).limit(1);

        // if (fetchError) {
        //   return res.status(500).json({ error: true, message: "Failed to fetch latest product number: " + fetchError.message });
        // }

        // let newNumber = 1;
        // if (maxNumberData && maxNumberData.length > 0) {
        //   newNumber = maxNumberData[0].number + 1;
        // }

        const { error: insertError } = await supabase.from("products").insert([
          {
            user_id: user.id,
            category,
            name,
            unit,
            sku,
            warehouses,
            description,
            sales_COA,
            cogs_COA,
            company_type: "Service",
            items_product: itemsProductPayload,
            created_at: new Date().toISOString(),
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to add product: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Product added successfully" });
      }

      // Add Warehouse Endpoint
      case "addWarehouse": {
        if (method !== "POST") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use POST for addWarehouse." });
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
        // const allowedRoles = ["inventory", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { name, location } = req.body;

        if (!name) {
          return res.status(400).json({ error: true, message: "Warehouse name is required" });
        }

        // Check if warehouse with this name already exists for this user
        const { data: existingWarehouse, error: checkError } = await supabase.from("warehouses").select("id, name").eq("user_id", user.id).eq("name", name).maybeSingle();

        if (checkError) {
          return res.status(500).json({ error: true, message: "Failed to check existing warehouse: " + checkError.message });
        }

        if (existingWarehouse) {
          return res.status(409).json({ error: true, message: `Warehouse with name "${name}" already exists` });
        }

        const { data: maxNumberData, error: fetchError } = await supabase.from("warehouses").select("number").order("number", { ascending: false }).limit(1);

        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch latest warehouse number: " + fetchError.message });
        }

        let newNumber = 1;
        if (maxNumberData && maxNumberData.length > 0) {
          newNumber = maxNumberData[0].number + 1;
        }

        const { error: insertError } = await supabase.from("warehouses").insert([
          {
            user_id: user.id,
            number: newNumber,
            name,
            location: location || null,
            total_stock: 0,
            created_at: new Date().toISOString(),
          },
        ]);

        if (insertError) {
          return res.status(500).json({ error: true, message: "Failed to add warehouse: " + insertError.message });
        }

        return res.status(201).json({ error: false, message: "Warehouse added successfully" });
      }

      // Edit Stock Endpoint
      case "editStock": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editStock." });
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
        // const allowedRoles = ["inventory", "procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, name, sku, category, unit, minimum_stock, warehouses, stock_COA, description, copyToProduct } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const { data: existingStock, error: fetchError } = await supabase.from("stock").select("*").eq("id", id).single();

        if (fetchError || !existingStock) {
          return res.status(404).json({ error: true, message: "Stock not found" });
        }

        // Auto-create warehouse(s) if they're being changed and don't exist
        let warehouseAutoCreated = [];
        if (warehouses) {
          const warehouseResult = await ensureWarehouseExists(supabase, user.id, warehouses);
          if (!warehouseResult.success) {
            return res.status(500).json({ error: true, message: warehouseResult.error });
          }
          warehouseAutoCreated = warehouseResult.createdWarehouses || [];
        }

        const { error: updateError } = await supabase
          .from("stock")
          .update({
            user_id: user.id,
            name,
            sku,
            category,
            unit,
            minimum_stock: Number(minimum_stock),
            warehouses,
            stock_COA,
            description,
            copyToProduct,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update stock: " + updateError.message });
        }

        // Update total_stock for both old and new warehouses
        // If warehouses changed, update both old and new warehouse total_stock
        if (warehouses && warehouses !== existingStock.warehouses) {
          await updateWarehouseTotalStock(supabase, user.id, existingStock.warehouses); // Update old warehouse
          await updateWarehouseTotalStock(supabase, user.id, warehouses); // Update new warehouse
        } else if (warehouses) {
          await updateWarehouseTotalStock(supabase, user.id, warehouses); // Update current warehouse
        }

        // Conditionally insert to products (first-time only):
        // If previous copyToProduct was unset (null/undefined/empty) AND request sets copyToProduct === true,
        // then insert a product using the same logic as addStock. If it was already set (true/false), skip insertion.
        const wasCopyToProductUnset = existingStock.copyToProduct === null || existingStock.copyToProduct === undefined || existingStock.copyToProduct === "";

        if (wasCopyToProductUnset && copyToProduct === true) {
          // Get the latest total_cogs data from inventory
          const { data: latestInventory, error: inventoryError } = await supabase.from("inventory").select("total_cogs").order("updated_at", { ascending: false }).limit(1).single();

          if (inventoryError) {
            return res.status(404).json({ error: true, message: "Total COGS data not found" });
          }

          // Use updated payload values if provided, otherwise fallback to existing stock values
          const prodName = name ?? existingStock.name;
          const prodSku = sku ?? existingStock.sku;
          const prodCategory = category ?? existingStock.category;
          const prodUnit = unit ?? existingStock.unit;
          const prodWarehouses = warehouses ?? existingStock.warehouses;
          const prodStockCOA = stock_COA ?? existingStock.stock_COA;

          const { error: insertProductError } = await supabase.from("products").insert([
            {
              user_id: user.id,
              name: prodName,
              sku: prodSku,
              category: prodCategory,
              unit: prodUnit,
              warehouses: prodWarehouses,
              company_type: "Merchandise or Manufacturing",
              items_product: {
                stock_COA: prodStockCOA,
                stock_name: prodName,
                sell_price: null,
                cogs: latestInventory?.total_cogs || 0,
              },
              created_at: new Date().toISOString(),
            },
          ]);

          if (insertProductError) {
            return res.status(500).json({ error: true, message: "Failed to insert data to product: " + insertProductError.message });
          }
        }

        // Build response message
        let responseMessage = "Stock updated successfully";
        if (warehouseAutoCreated.length > 0) {
          const createdList = warehouseAutoCreated.map((w) => `"${w}"`).join(", ");
          responseMessage += ` (Warehouse${warehouseAutoCreated.length > 1 ? "s" : ""} ${createdList} auto-created)`;
        }

        return res.status(200).json({ error: false, message: responseMessage });
      }

      // Edit Product Endpoint
      case "editProduct": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editProduct." });
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
        // const allowedRoles = ["inventory", "procurement", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const {
          id,
          category,
          name,
          unit,
          sku,
          warehouses,
          description,
          sales_COA,
          cogs_COA,
          items_product,
          // legacy (optional)
          stock_COA,
          stock_name,
          sell_price,
          cogs,
        } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Missing required fields" });
        }

        const itemsProductPayload =
          items_product && typeof items_product === "object"
            ? {
                stock_COA: items_product.stock_COA ?? null,
                stock_name: items_product.stock_name ?? null,
                sell_price: items_product.sell_price != null ? Number(items_product.sell_price) : null,
                cogs: items_product.cogs != null ? Number(items_product.cogs) : null,
              }
            : {
                stock_COA: stock_COA ?? null,
                stock_name: stock_name ?? null,
                sell_price: sell_price != null ? Number(sell_price) : null,
                cogs: cogs != null ? Number(cogs) : null,
              };

        // const allowedStatuses = ["In Stock", "Out of Stock"];
        // if (!allowedStatuses.includes(status)) {
        //   return res.status(400).json({ error: true, message: `Invalid status. Allowed values: ${allowedStatuses.join(", ")}` });
        // }

        // const { data: existingProduct, error: fetchError } = await supabase.from("products").select("id").eq("id", id);

        // if (fetchError || !existingProduct || existingProduct.length === 0) {
        //   return res.status(404).json({ error: true, message: "Product not found or does not belong to user" });
        // }

        const { error: updateError } = await supabase
          .from("products")
          .update({
            user_id: user.id,
            category,
            name,
            unit,
            sku,
            warehouses,
            description,
            sales_COA,
            cogs_COA,
            company_type: "Service",
            items_product: itemsProductPayload,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update product: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Product updated successfully" });
      }

      // Edit Warehouse Endpoint
      case "editWarehouse": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editWarehouse." });
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
        // const allowedRoles = ["inventory", "manager", "admin"];
        // if (!allowedRoles.includes(userProfile.role.toLowerCase())) {
        //   return res.status(403).json({
        //     error: true,
        //     message: "Access denied. You are not authorized to perform this action.",
        //   });
        // }

        const { id, name, location } = req.body;

        if (!id) {
          return res.status(400).json({ error: true, message: "Warehouse ID is required" });
        }

        // Check if warehouse exists
        const { data: existingWarehouse, error: fetchError } = await supabase.from("warehouses").select("*").eq("id", id).eq("user_id", user.id).single();

        if (fetchError || !existingWarehouse) {
          return res.status(404).json({ error: true, message: "Warehouse not found" });
        }

        // If name is being changed, check for duplicates
        if (name && name !== existingWarehouse.name) {
          const { data: duplicateWarehouse, error: checkError } = await supabase.from("warehouses").select("id").eq("user_id", user.id).eq("name", name).neq("id", id).maybeSingle();

          if (checkError) {
            return res.status(500).json({ error: true, message: "Failed to check duplicate warehouse: " + checkError.message });
          }

          if (duplicateWarehouse) {
            return res.status(409).json({ error: true, message: `Warehouse with name "${name}" already exists` });
          }
        }

        const { error: updateError } = await supabase
          .from("warehouses")
          .update({
            name: name ?? existingWarehouse.name,
            location: location ?? existingWarehouse.location,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateError) {
          return res.status(500).json({ error: true, message: "Failed to update warehouse: " + updateError.message });
        }

        return res.status(200).json({ error: false, message: "Warehouse updated successfully" });
      }

      // Delete Product, Warehouse, Bill of Material, Production Plan, Stock Endpoint
      case "deleteProduct":
      case "deleteWarehouse":
      case "deleteBillOfMaterial":
      case "deleteProductionPlan":
      case "deleteStock": {
        if (method !== "DELETE") {
          return res.status(405).json({ error: true, message: `Method not allowed. Use DELETE for ${action}.` });
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

        // // Role permissions per case
        // const permissionsMap = {
        //   deleteProduct: ["inventory", "procurement", "manager", "admin"],
        //   deleteWarehouse: ["inventory", "manager", "admin"],
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

        const { id } = req.body;

        if (!id) {
          return res.status(400).json({
            error: true,
            message: `${action === "deleteProduct" ? "Product" : action === "deleteWarehouse" ? "Warehouse" : action === "deleteBillOfMaterial" ? "Bill of Material" : "Stock"} ID is required`,
          });
        }

        const tableName = action === "deleteProduct" ? "products" : action === "deleteWarehouse" ? "warehouses" : action === "deleteBillOfMaterial" ? "bill_of_material" : action === "deleteProductionPlan" ? "production_plan" : "stock";

        const entityName = action === "deleteProduct" ? "Product" : action === "deleteWarehouse" ? "Warehouse" : action === "deleteBillOfMaterial" ? "Bill of Material" : action === "deleteProductionPlan" ? "Production Plan" : "Stock";

        const { data: record, error: fetchError } = await supabase.from(tableName).select("*").eq("id", id);

        if (fetchError || !record || record.length === 0) {
          return res.status(404).json({ error: true, message: `${entityName} not found` });
        }

        // If deleting stock, save warehouses info before deletion to update total_stock
        let warehousesToUpdate = null;
        if (action === "deleteStock" && record[0].warehouses) {
          warehousesToUpdate = record[0].warehouses;
        }

        const { error: deleteError } = await supabase.from(tableName).delete().eq("id", id);

        if (deleteError) {
          return res.status(500).json({ error: true, message: `Failed to delete ${entityName.toLowerCase()}: ` + deleteError.message });
        }

        // Update total_stock for affected warehouses after stock deletion
        if (action === "deleteStock" && warehousesToUpdate) {
          await updateWarehouseTotalStock(supabase, user.id, warehousesToUpdate);
        }

        return res.status(200).json({ error: false, message: `${entityName} deleted successfully` });
      }

      // Get Bill of Materials Endpoint
      case "getBillOfMaterials": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getBillOfMaterials." });
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

        const filterCategory = req.query.category;
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("bill_of_material").select("*").order("created_at", { ascending: false }).range(from, to);

        if (filterCategory) {
          query = query.eq("category", filterCategory);
        }

        if (search) {
          const stringColumns = ["bom_name", "sku", "category", "process_name", "job_desc"];
          const numericColumns = ["qty_goods_est", "est_compl_time", "total_foc_est", "total_cogm_est", "cogm_unit_est"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqNumericConditions = [];

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqNumericConditions.push(...numericColumns.map((col) => `${col}.eq.${parseFloat(search)}`));
          }

          const searchConditions = [...ilikeConditions, ...eqNumericConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;
        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch bill of materials: " + fetchError.message });
        }

        return res.status(200).json({ error: false, data });
      }

      // Get Production Plans Endpoint
      case "getProductionPlan": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getProductionPlan." });
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

        const filterCategory = req.query.category;
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("production_plan").select("*").order("created_at", { ascending: false }).range(from, to);

        if (filterCategory) {
          query = query.eq("category", filterCategory);
        }

        if (search) {
          const stringColumns = ["product_name", "sku", "category", "process_name", "job_desc"];
          const numericColumns = ["qty_goods_est", "total_qty_goods_est", "total_foc_est", "total_cogm_est", "cogm_unit_est"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqNumericConditions = [];

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqNumericConditions.push(...numericColumns.map((col) => `${col}.eq.${parseFloat(search)}`));
          }

          const searchConditions = [...ilikeConditions, ...eqNumericConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;
        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch production plans: " + fetchError.message });
        }

        return res.status(200).json({ error: false, data });
      }

      // Get Inventories Endpoint
      case "getInventories": {
        if (method !== "GET") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use GET for getInventories." });
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

        // Filters: date range (inventory_date) and transaction type (type)
        const startDate = req.query.startDate; // expected format: YYYY-MM-DD or ISO
        const endDate = req.query.endDate; // expected format: YYYY-MM-DD or ISO
        const typeFilter = req.query.type; // e.g. 'purchase', 'sale', 'adjustment'

        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from("inventory").select("*").order("inventory_date", { ascending: false }).range(from, to);

        if (startDate && endDate) {
          query = query.gte("inventory_date", startDate).lte("inventory_date", endDate);
        } else if (startDate) {
          query = query.gte("inventory_date", startDate);
        } else if (endDate) {
          query = query.lte("inventory_date", endDate);
        }

        if (typeFilter) {
          query = query.eq("type", typeFilter);
        }

        if (search) {
          // columns to perform ilike search against
          const stringColumns = ["product_name", "sku", "type", "warehouse", "remarks"];
          const numericColumns = ["quantity", "total_cogs"];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqNumericConditions = [];

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqNumericConditions.push(...numericColumns.map((col) => `${col}.eq.${parseFloat(search)}`));
          }

          const searchConditions = [...ilikeConditions, ...eqNumericConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;
        if (fetchError) {
          return res.status(500).json({ error: true, message: "Failed to fetch inventories: " + fetchError.message });
        }

        return res.status(200).json({ error: false, data });
      }

      // Get All Products, Warehouses Endpoint
      case "getStocks":
      case "getProducts":
      case "getWarehouses": {
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

        // // Role permissions per case
        // const permissionsMap = {
        //   getProducts: ["inventory", "procurement", "manager", "admin"],
        //   getWarehouses: ["inventory", "manager", "admin"],
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

        const tableName = action === "getProducts" ? "products" : action === "getStocks" ? "stock" : "warehouses";
        const filterField = action === "getProducts" ? "category" : "location";
        const prefix = action === "getProducts" ? "PRD" : "WH";
        const filterValue = req.query[filterField];
        const search = req.query.search?.toLowerCase();
        const pagination = parseInt(req.query.page) || 1;
        const limitValue = parseInt(req.query.limit) || 10;
        const from = (pagination - 1) * limitValue;
        const to = from + limitValue - 1;

        let query = supabase.from(tableName).select("*").order("created_at", { ascending: false }).range(from, to);

        if (filterValue) {
          query = query.eq(filterField, filterValue);
        }

        if (search) {
          const stringColumns = action === "getProducts" ? ["category", "name", "unit", "status"] : action === "getStocks" ? ["name", "sku", "category", "unit", "warehouses"] : ["name", "location"];

          const intColumns = action === "getProducts" ? ["total_stock", "min_stock"] : action === "getStocks" ? ["minimum_stock"] : ["total_stock"];

          const numericColumns = action === "getProducts" ? ["buy_price", "sell_price"] : [];

          const ilikeConditions = stringColumns.map((col) => `${col}.ilike.%${search}%`);
          const eqIntConditions = [];
          const eqNumericConditions = [];

          if (!isNaN(search) && Number.isInteger(Number(search))) {
            eqIntConditions.push(...intColumns.map((col) => `${col}.eq.${search}`));
          }

          if (!isNaN(search) && !Number.isNaN(parseFloat(search))) {
            eqNumericConditions.push(...numericColumns.map((col) => `${col}.eq.${parseFloat(search)}`));
          }

          const codeMatch = search.match(/^(PRD|WH)(\d{3,})$/i);
          if (codeMatch) {
            const codeNum = parseInt(codeMatch[2], 10); // example = PRD001 --> 1

            if (!isNaN(codeNum)) {
              eqIntConditions.push(`number.eq.${codeNum}`);
            }
          }

          const searchConditions = [...ilikeConditions, ...eqIntConditions, ...eqNumericConditions].join(",");
          query = query.or(searchConditions);
        }

        const { data, error: fetchError } = await query;
        if (fetchError) {
          return res.status(500).json({ error: true, message: `Failed to fetch ${tableName}: ${fetchError.message}` });
        }

        let formattedData = data.map((item) => ({
          ...item,
          // number: `${prefix}${String(item.number).padStart(3, "0")}`,
        }));

        // For getWarehouses, fetch stock items for each warehouse
        if (action === "getWarehouses") {
          const warehousesWithStock = await Promise.all(
            formattedData.map(async (warehouse) => {
              // Fetch stock items where warehouses field contains this warehouse name
              // Support both string and array formats
              const { data: allStocks, error: stockError } = await supabase.from("stock").select("*").eq("user_id", user.id);

              if (stockError) {
                console.error(`Error fetching stock for warehouse ${warehouse.name}:`, stockError);
                return {
                  ...warehouse,
                  stock_items: [],
                  stock_count: 0,
                };
              }

              // Filter stocks that contain this warehouse name
              // Works for both string format: "Warehouse A" and array format: ["Warehouse A", "Warehouse B"]
              const stockItems = (allStocks || []).filter((stock) => {
                if (typeof stock.warehouses === "string") {
                  return stock.warehouses === warehouse.name;
                } else if (Array.isArray(stock.warehouses)) {
                  return stock.warehouses.includes(warehouse.name);
                }
                return false;
              });

              const stockCount = stockItems.length;

              // Auto-update total_stock in database if different
              if (warehouse.total_stock !== stockCount) {
                await supabase
                  .from("warehouses")
                  .update({
                    total_stock: stockCount,
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", warehouse.id);
              }

              return {
                ...warehouse,
                total_stock: stockCount, // Update total_stock dengan jumlah stock items aktual
                stock_items: stockItems,
                stock_count: stockCount,
              };
            })
          );

          formattedData = warehousesWithStock;
        }

        return res.status(200).json({ error: false, formattedData });
      }

      // Non-existent Endpoint
      // Edit Production Plan Endpoint
      case "editProductionPlan": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editProductionPlan." });
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

        const { id, prod_code, job_order_num, total_prod_order, warehouse, schedule } = req.body;

        if (!id) return res.status(400).json({ error: true, message: "Production plan id is required" });
        if (total_prod_order === undefined || total_prod_order === null) return res.status(400).json({ error: true, message: "total_prod_order is required" });

        const toNum = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

        // Auto-create warehouse(s) if provided and don't exist (same logic as editStock)
        let warehouseAutoCreated = [];
        if (warehouse) {
          const warehouseResult = await ensureWarehouseExists(supabase, user.id, warehouse);
          if (!warehouseResult.success) {
            return res.status(500).json({ error: true, message: warehouseResult.error });
          }
          warehouseAutoCreated = warehouseResult.createdWarehouses || [];
        }

        // Fetch existing production plan
        const { data: existingPlan, error: fetchError } = await supabase.from("production_plan").select("*").eq("id", id).single();

        if (fetchError || !existingPlan) return res.status(404).json({ error: true, message: "Production plan not found" });

        const existingProcesses = Array.isArray(existingPlan.processes) ? existingPlan.processes : [];

        // Recalculate processes based on total_prod_order
        let agg_total_direct_material = 0;
        let agg_total_direct_labor = 0;
        let agg_total_indirect_material = 0;
        let agg_total_indirect_labor = 0;
        let agg_total_items_depreciation = 0;
        let agg_total_utilities_cost = 0;
        let agg_total_other_foc = 0;

        // Determine previous multiplier (if this plan was already scaled before)
        const prevProdOrder = toNum(existingPlan.total_prod_order) || 1;

        const updatedProcesses = existingProcesses.map((p) => {
          const direct_material = (p.direct_material || []).map((it) => {
            // compute base per-unit qty by undoing previous scaling (if any)
            const baseQtyPerUnit = prevProdOrder ? toNum(it.qty) / prevProdOrder : toNum(it.qty);
            const newQty = baseQtyPerUnit * toNum(total_prod_order);
            const price = toNum(it.price);
            const total = newQty * price;
            agg_total_direct_material += total;
            return {
              ...it,
              qty: newQty,
              price,
              total,
            };
          });

          const direct_labor = (p.direct_labor || []).map((it) => {
            const qty = toNum(it.qty);
            // undo previous scaling on order_compl_time
            const baseOrderPerUnit = prevProdOrder ? toNum(it.order_compl_time) / prevProdOrder : toNum(it.order_compl_time);
            const newOrder = baseOrderPerUnit * toNum(total_prod_order);
            const rate_per_hours = toNum(it.rate_per_hours);
            const total_est_rate = qty * newOrder * rate_per_hours;
            agg_total_direct_labor += total_est_rate;
            return {
              ...it,
              order_compl_time: newOrder,
              rate_per_hours,
              total_est_rate,
            };
          });

          const indirect_material = (p.indirect_material || []).map((it) => {
            const baseQtyPerUnit = prevProdOrder ? toNum(it.qty) / prevProdOrder : toNum(it.qty);
            const newQty = baseQtyPerUnit * toNum(total_prod_order);
            const price = toNum(it.price);
            const total = newQty * price;
            agg_total_indirect_material += total;
            return {
              ...it,
              qty: newQty,
              price,
              total,
            };
          });

          const indirect_labor = (p.indirect_labor || []).map((it) => {
            const qty = toNum(it.qty);
            const baseOrderPerUnit = prevProdOrder ? toNum(it.order_compl_time) / prevProdOrder : toNum(it.order_compl_time);
            const newOrder = baseOrderPerUnit * toNum(total_prod_order);
            const rate_per_hours = toNum(it.rate_per_hours);
            const total_est_rate = qty * newOrder * rate_per_hours;
            agg_total_indirect_labor += total_est_rate;
            return {
              ...it,
              order_compl_time: newOrder,
              rate_per_hours,
              total_est_rate,
            };
          });

          const items_depreciation = (p.items_depreciation || []).map((it) => {
            // Prefer using stored total_est_rate (if present) to derive base per-unit value.
            const storedTotal = toNum(it.total_est_rate) || 0;
            let baseRateEstimatedPerUnit = 0;
            if (storedTotal && prevProdOrder) {
              baseRateEstimatedPerUnit = storedTotal / prevProdOrder;
            } else {
              baseRateEstimatedPerUnit = toNum(it.rate_estimated) || storedTotal || 0;
            }
            const total_est_rate = baseRateEstimatedPerUnit * toNum(total_prod_order);
            agg_total_items_depreciation += total_est_rate;
            return {
              ...it,
              // store the per-unit rate_estimated (keeps consistency)
              rate_estimated: baseRateEstimatedPerUnit,
              total_est_rate,
            };
          });

          const utilities_cost = (p.utilities_cost || []).map((it) => {
            const baseEstPerUnit = prevProdOrder ? toNum(it.est_qty) / prevProdOrder : toNum(it.est_qty);
            const newEst = baseEstPerUnit * toNum(total_prod_order);
            const rate = toNum(it.price);
            const total_est_rate = newEst * rate;
            agg_total_utilities_cost += total_est_rate;
            return {
              ...it,
              est_qty: newEst,
              rate,
              total_est_rate,
            };
          });

          const other_foc = (p.other_foc || []).map((it) => {
            const baseEstPerUnit = prevProdOrder ? toNum(it.est_qty) / prevProdOrder : toNum(it.est_qty);
            const newEst = baseEstPerUnit * toNum(total_prod_order);
            const rate = toNum(it.price);
            const total_est_rate = newEst * rate;
            agg_total_other_foc += total_est_rate;
            return {
              ...it,
              est_qty: newEst,
              rate,
              total_est_rate,
            };
          });

          return {
            process_name: p.process_name,
            job_desc: p.job_desc,
            direct_material,
            direct_labor,
            indirect_material,
            indirect_labor,
            items_depreciation,
            utilities_cost,
            other_foc,
          };
        });

        // Aggregate totals
        const total_foc_est = agg_total_indirect_material + agg_total_indirect_labor + agg_total_items_depreciation + agg_total_utilities_cost + agg_total_other_foc;
        const total_cogm_est = agg_total_direct_material + agg_total_direct_labor + total_foc_est;
        // total_qty_goods_est = total_prod_order * qty_goods_est (from BOM/production plan)
        const total_qty_goods_est = toNum(total_prod_order) * toNum(existingPlan.qty_goods_est);
        const cogm_unit_est = total_qty_goods_est ? total_cogm_est / total_qty_goods_est : 0;

        // Update production_plan
        const { error: updateErr } = await supabase
          .from("production_plan")
          .update({
            prod_code: prod_code ?? existingPlan.prod_code,
            job_order_num: job_order_num ?? existingPlan.job_order_num,
            total_prod_order: toNum(total_prod_order),
            warehouse: warehouse ?? existingPlan.warehouse,
            schedule: schedule ?? existingPlan.schedule,
            processes: updatedProcesses,
            total_qty_goods_est: round0(total_qty_goods_est),
            total_direct_material: round0(agg_total_direct_material),
            total_direct_labor: round0(agg_total_direct_labor),
            total_indirect_material: round0(agg_total_indirect_material),
            total_indirect_labor: round0(agg_total_indirect_labor),
            total_items_depreciation: round0(agg_total_items_depreciation),
            total_utilities_cost: round0(agg_total_utilities_cost),
            total_other_foc: round0(agg_total_other_foc),
            total_foc_est: round0(total_foc_est),
            total_cogm_est: round0(total_cogm_est),
            cogm_unit_est: round0(cogm_unit_est),
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateErr) {
          return res.status(500).json({ error: true, message: "Failed to update production plan: " + updateErr.message });
        }

        // If all required fields are present after update, insert into work_in_process
        try {
          // Determine final values (use request overrides if provided)
          const finalProductName = existingPlan.product_name ?? null;
          const finalProdCode = prod_code ?? existingPlan.prod_code ?? null;
          const finalJobOrderNum = job_order_num ?? existingPlan.job_order_num ?? null;
          const finalSku = existingPlan.sku ?? null;
          const finalTotalProdOrder = toNum(total_prod_order);
          const finalQtyGoodsEst = toNum(existingPlan.qty_goods_est);
          const finalTotalQtyGoodsEst = toNum(total_qty_goods_est);
          const finalCategory = existingPlan.category ?? null;
          const finalWarehouse = warehouse ?? existingPlan.warehouse ?? null;
          const finalSchedule = schedule ?? existingPlan.schedule ?? null;

          const allPresent = [
            finalProductName,
            finalProdCode,
            finalJobOrderNum,
            finalSku,
            // total_prod_order may be 0 but must be present (we already validated it's provided)
            typeof finalTotalProdOrder === "number",
            typeof finalQtyGoodsEst === "number",
            typeof finalTotalQtyGoodsEst === "number",
            finalCategory,
            finalWarehouse,
            finalSchedule,
          ].every((v) => v !== null && v !== undefined && v !== "");

          if (allPresent) {
            // Prepare work_in_process record
            const wipRecord = {
              user_id: user.id,
              product_name: finalProductName,
              prod_code: finalProdCode,
              job_order_num: finalJobOrderNum,
              sku: finalSku,
              total_prod_order: finalTotalProdOrder,
              qty_goods_est: finalQtyGoodsEst,
              total_qty_goods_est: round0(finalTotalQtyGoodsEst),
              total_direct_material: round0(agg_total_direct_material),
              total_direct_labor: round0(agg_total_direct_labor),
              total_indirect_material: round0(agg_total_indirect_material),
              total_indirect_labor: round0(agg_total_indirect_labor),
              total_items_depreciation: round0(agg_total_items_depreciation),
              total_utilities_cost: round0(agg_total_utilities_cost),
              total_other_foc: round0(agg_total_other_foc),
              category: finalCategory,
              warehouse: finalWarehouse,
              schedule: finalSchedule,
              processes: updatedProcesses, // use recalculated processes
              total_foc_est: round0(total_foc_est),
              total_cogm_est: round0(total_cogm_est),
              cogm_unit_est: round0(cogm_unit_est),
              created_at: new Date().toISOString(),
            };

            // Check if a WIP record already exists for this production plan (match by prod_code/job_order_num/sku and user_id)
            let existingWipRecord = null;
            try {
              // Prefer matching by prod_code + user
              if (finalProdCode) {
                const { data: found, error: fErr } = await supabase.from("work_in_process").select("*").eq("prod_code", finalProdCode).maybeSingle();
                if (!fErr && found) existingWipRecord = found;
              }

              // If not found and job_order_num present, try matching by job_order_num
              if (!existingWipRecord && finalJobOrderNum) {
                const { data: found2, error: f2Err } = await supabase.from("work_in_process").select("*").eq("job_order_num", finalJobOrderNum).maybeSingle();
                if (!f2Err && found2) existingWipRecord = found2;
              }
            } catch (wipFetchErr) {
              console.error("Failed to lookup existing work_in_process:", wipFetchErr);
            }

            if (existingWipRecord && existingWipRecord.id) {
              // Update existing WIP record instead of inserting a new one
              const updatePayload = {
                product_name: finalProductName,
                prod_code: finalProdCode,
                job_order_num: finalJobOrderNum,
                sku: finalSku,
                total_prod_order: finalTotalProdOrder,
                qty_goods_est: finalQtyGoodsEst,
                total_qty_goods_est: round0(finalTotalQtyGoodsEst),
                total_direct_material: round0(agg_total_direct_material),
                total_direct_labor: round0(agg_total_direct_labor),
                total_indirect_material: round0(agg_total_indirect_material),
                total_indirect_labor: round0(agg_total_indirect_labor),
                total_items_depreciation: round0(agg_total_items_depreciation),
                total_utilities_cost: round0(agg_total_utilities_cost),
                total_other_foc: round0(agg_total_other_foc),
                category: finalCategory,
                warehouse: finalWarehouse,
                schedule: finalSchedule,
                processes: updatedProcesses, // use recalculated processes
                total_foc_est: round0(total_foc_est),
                total_cogm_est: round0(total_cogm_est),
                cogm_unit_est: round0(cogm_unit_est),
                updated_at: new Date().toISOString(),
              };

              const { error: updateWipErr } = await supabase.from("work_in_process").update(updatePayload).eq("id", existingWipRecord.id);
              if (updateWipErr) {
                return res.status(500).json({ error: true, message: "Failed to update existing work_in_process: " + updateWipErr.message });
              }
            } else {
              // Insert new WIP record
              const { error: insertWipErr } = await supabase.from("work_in_process").insert([wipRecord]);
              if (insertWipErr) {
                // If insertion fails, return error so caller knows WIP wasn't saved
                return res.status(500).json({ error: true, message: "Failed to insert work_in_process: " + insertWipErr.message });
              }
            }
          }
        } catch (wipErr) {
          console.error("Error while inserting work_in_process:", wipErr);
          return res.status(500).json({ error: true, message: "Internal error while creating work_in_process" });
        }

        // Build response message and include info about any auto-created warehouses
        let responseMessage = "Production plan updated successfully";
        if (warehouseAutoCreated.length > 0) {
          const createdList = warehouseAutoCreated.map((w) => `"${w}"`).join(", ");
          responseMessage += ` (Warehouse${warehouseAutoCreated.length > 1 ? "s" : ""} ${createdList} auto-created)`;
        }

        return res.status(200).json({
          error: false,
          message: responseMessage,
          data: {
            id,
            total_qty_goods_est: round0(total_qty_goods_est),
            total_direct_material: round0(agg_total_direct_material),
            total_direct_labor: round0(agg_total_direct_labor),
            total_indirect_material: round0(agg_total_indirect_material),
            total_indirect_labor: round0(agg_total_indirect_labor),
            total_items_depreciation: round0(agg_total_items_depreciation),
            total_utilities_cost: round0(agg_total_utilities_cost),
            total_other_foc: round0(agg_total_other_foc),
            total_foc_est: round0(total_foc_est),
            total_cogm_est: round0(total_cogm_est),
            cogm_unit_est: round0(cogm_unit_est),
          },
        });
      }

      // Edit Work In Process Endpoint
      case "editWorkInProcess": {
        if (method !== "PUT") {
          return res.status(405).json({ error: true, message: "Method not allowed. Use PUT for editWorkInProcess." });
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

        // Expected body:
        // {
        //   id: <work_in_process id>,
        //   actuals: { [process_name]: { other_foc_actual: [{rate, est_qty}, ...], direct_labor_actual: [{qty, rate_per_hours, order_compl_time}, ...], ... } },
        //   coa_finished_goods, coa_defective_goods, coa_expenses,
        //   total_finished_goods, total_defective_goods, total_expenses
        // }

        const { id, processes_actual = [], coa_finished_goods, coa_defective_goods, coa_expenses, total_finished_goods, total_defective_goods, total_expenses } = req.body;
        // allow backward-compatible 'actuals' object, but prefer mapping from processes_actual array when provided
        let actuals = req.body.actuals || {};

        if (!id) return res.status(400).json({ error: true, message: "work_in_process id is required" });

        const toNum = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

        // Fetch existing WIP
        const { data: existingWip, error: fetchErr } = await supabase.from("work_in_process").select("*").eq("id", id).single();
        if (fetchErr || !existingWip) return res.status(404).json({ error: true, message: "Work In Process not found" });

        const existingProcesses = Array.isArray(existingWip.processes) ? existingWip.processes : [];

        // If client sent processes_actual as an array, map it to process_name keys by index
        // Fallback: if fewer items provided, use the first element for remaining originals
        if (Array.isArray(processes_actual) && processes_actual.length > 0) {
          const mapped = {};
          for (let i = 0; i < existingProcesses.length; i++) {
            const pname = existingProcesses[i] && existingProcesses[i].process_name ? existingProcesses[i].process_name : `process_${i}`;
            mapped[pname] = processes_actual[i] || processes_actual[0] || {};
          }
          // Merge with any explicitly provided actuals (explicit keys win)
          actuals = { ...mapped, ...actuals };
        }

        // Totals accumulators
        let total_other_foc_actual = 0;
        let total_direct_labor_actual = 0;
        let total_indirect_labor_actual = 0;
        let total_utilities_cost_actual = 0;
        let total_direct_material_actual = 0;
        let total_indirect_material_actual = 0;
        let total_items_depreciation_actual = 0;

        // Process each process and append actual arrays
        const updatedProcesses = existingProcesses.map((proc) => {
          const procName = proc.process_name;
          const procActualInputs = actuals[procName] || {};

          const newProc = { ...proc };

          // Helper to duplicate and create actual entries based on original array and provided inputs
          const buildActualList = (origList, inputsList, mapper) => {
            if (!Array.isArray(origList) || origList.length === 0) return [];
            const results = [];
            for (let i = 0; i < origList.length; i++) {
              const orig = origList[i] || {};
              const input = Array.isArray(inputsList) ? inputsList[i] || inputsList[0] || {} : inputsList || {};
              const built = mapper(orig, input);
              results.push(built);
            }
            return results;
          };

          // 1) other_foc_actual
          if (Array.isArray(proc.other_foc_actual) && proc.other_foc_actual.length > 0) {
            // already has actuals stored — use them and accumulate totals (avoid duplication)
            for (const a of proc.other_foc_actual) {
              total_other_foc_actual += toNum(a.total_est_rate || (a.rate && a.est_qty ? a.rate * a.est_qty : 0));
            }
          } else {
            const otherInputs = procActualInputs.other_foc_actual || [];
            const otherActual = buildActualList(proc.other_foc || [], otherInputs, (orig, input) => {
              const rate = toNum(input.rate);
              const est_qty = toNum(input.est_qty);
              const total_est_rate = round2(est_qty * rate);
              total_other_foc_actual += total_est_rate;
              return {
                coa: orig.coa,
                desc: orig.desc,
                rate: round2(rate),
                unit: orig.unit,
                price: round2(orig.price || 0),
                est_qty: round2(est_qty),
                item_name: orig.item_name,
                total_est_rate,
              };
            });
            if (otherActual.length > 0) newProc.other_foc_actual = otherActual;
          }

          // 2) direct_labor_actual
          if (Array.isArray(proc.direct_labor_actual) && proc.direct_labor_actual.length > 0) {
            for (const a of proc.direct_labor_actual) {
              total_direct_labor_actual += toNum(a.total_est_rate || (a.qty && a.rate_per_hours && a.order_compl_time ? a.qty * a.rate_per_hours * a.order_compl_time : 0));
            }
          } else {
            const dlInputs = procActualInputs.direct_labor_actual || [];
            const dlActual = buildActualList(proc.direct_labor || [], dlInputs, (orig, input) => {
              const qty = toNum(input.qty);
              const rate_per_hours = toNum(input.rate_per_hours);
              const order_compl_time = toNum(input.order_compl_time);
              const total_est_rate = round2(qty * rate_per_hours * order_compl_time);
              total_direct_labor_actual += total_est_rate;
              return {
                coa: orig.coa,
                qty: round2(qty),
                desc: orig.desc,
                unit: orig.unit,
                item_name: orig.item_name,
                rate_per_hours: round2(rate_per_hours),
                total_est_rate,
                order_compl_time: round2(order_compl_time),
              };
            });
            if (dlActual.length > 0) newProc.direct_labor_actual = dlActual;
          }

          // 3) indirect_labor_actual
          if (Array.isArray(proc.indirect_labor_actual) && proc.indirect_labor_actual.length > 0) {
            for (const a of proc.indirect_labor_actual) {
              total_indirect_labor_actual += toNum(a.total_est_rate || (a.qty && a.rate_per_hours && a.order_compl_time ? a.qty * a.rate_per_hours * a.order_compl_time : 0));
            }
          } else {
            const ilInputs = procActualInputs.indirect_labor_actual || [];
            const ilActual = buildActualList(proc.indirect_labor || [], ilInputs, (orig, input) => {
              const qty = toNum(input.qty);
              const rate_per_hours = toNum(input.rate_per_hours);
              const order_compl_time = toNum(input.order_compl_time);
              const total_est_rate = round2(qty * rate_per_hours * order_compl_time);
              total_indirect_labor_actual += total_est_rate;
              return {
                coa: orig.coa,
                qty: round2(qty),
                desc: orig.desc,
                unit: orig.unit,
                item_name: orig.item_name,
                rate_per_hours: round2(rate_per_hours),
                total_est_rate,
                order_compl_time: round2(order_compl_time),
              };
            });
            if (ilActual.length > 0) newProc.indirect_labor_actual = ilActual;
          }

          // 4) utilities_cost_actual
          if (Array.isArray(proc.utilities_cost_actual) && proc.utilities_cost_actual.length > 0) {
            for (const a of proc.utilities_cost_actual) {
              total_utilities_cost_actual += toNum(a.total_est_rate || (a.rate && a.est_qty ? a.rate * a.est_qty : 0));
            }
          } else {
            const utilInputs = procActualInputs.utilities_cost_actual || [];
            const utilActual = buildActualList(proc.utilities_cost || [], utilInputs, (orig, input) => {
              const rate = toNum(input.rate);
              const est_qty = toNum(input.est_qty);
              const total_est_rate = round2(est_qty * rate);
              total_utilities_cost_actual += total_est_rate;
              return {
                coa: orig.coa,
                desc: orig.desc,
                rate: round2(rate),
                unit: orig.unit,
                price: round2(orig.price || 0),
                est_qty: round2(est_qty),
                item_name: orig.item_name,
                total_est_rate,
              };
            });
            if (utilActual.length > 0) newProc.utilities_cost_actual = utilActual;
          }

          // 5) direct_material_actual
          if (Array.isArray(proc.direct_material_actual) && proc.direct_material_actual.length > 0) {
            for (const a of proc.direct_material_actual) {
              total_direct_material_actual += toNum(a.total || (a.qty && a.price ? a.qty * a.price : 0));
            }
          } else {
            const dmInputs = procActualInputs.direct_material_actual || [];
            const dmActual = buildActualList(proc.direct_material || [], dmInputs, (orig, input) => {
              const qty = toNum(input.qty);
              const price = toNum(input.price);
              const total = round2(qty * price);
              total_direct_material_actual += total;
              return {
                coa: orig.coa,
                qty: round2(qty),
                desc: orig.desc,
                unit: orig.unit,
                price: round2(price),
                total,
                item_name: orig.item_name,
              };
            });
            if (dmActual.length > 0) newProc.direct_material_actual = dmActual;
          }

          // 6) indirect_material_actual
          if (Array.isArray(proc.indirect_material_actual) && proc.indirect_material_actual.length > 0) {
            for (const a of proc.indirect_material_actual) {
              total_indirect_material_actual += toNum(a.total || (a.qty && a.price ? a.qty * a.price : 0));
            }
          } else {
            const imInputs = procActualInputs.indirect_material_actual || [];
            const imActual = buildActualList(proc.indirect_material || [], imInputs, (orig, input) => {
              const qty = toNum(input.qty);
              const price = toNum(input.price);
              const total = round2(qty * price);
              total_indirect_material_actual += total;
              return {
                coa: orig.coa,
                qty: round2(qty),
                desc: orig.desc,
                unit: orig.unit,
                price: round2(price),
                total,
                item_name: orig.item_name,
              };
            });
            if (imActual.length > 0) newProc.indirect_material_actual = imActual;
          }

          // 7) items_depreciation_actual
          if (Array.isArray(proc.items_depreciation_actual) && proc.items_depreciation_actual.length > 0) {
            for (const a of proc.items_depreciation_actual) {
              total_items_depreciation_actual += toNum(a.total_est_rate || 0);
            }
          } else {
            const depInputs = procActualInputs.items_depreciation_actual || [];
            const depActual = buildActualList(proc.items_depreciation || [], depInputs, (orig, input) => {
              const total_est_rate = round2(toNum(input.total_est_rate));
              total_items_depreciation_actual += total_est_rate;
              return {
                coa: orig.coa,
                qty: orig.qty,
                desc: orig.desc,
                unit: orig.unit,
                item_name: orig.item_name,
                rate_estimated: round2(orig.rate_estimated || 0),
                total_est_rate,
              };
            });
            if (depActual.length > 0) newProc.items_depreciation_actual = depActual;
          }

          return newProc;
        });

        // Aggregate totals
        const total_foc_actual = total_indirect_material_actual + total_indirect_labor_actual + total_items_depreciation_actual + total_utilities_cost_actual + total_other_foc_actual;
        const total_cogm_actual = total_foc_actual + total_direct_material_actual + total_direct_labor_actual;

        const tf = toNum(total_finished_goods);
        const td = toNum(total_defective_goods);
        const te = toNum(total_expenses);

        const denom = tf + td + te;
        const prod_loss = denom !== 0 ? te * (total_cogm_actual / denom) : 0;
        const nett_total_cogm = total_cogm_actual - prod_loss;
        const cogm_per_unit_actual = tf + td > 0 ? nett_total_cogm / (tf + td) : 0;

        // cost_variance = total_cogm_actual - total_cogm_est (take from existing record if available)
        const total_cogm_est_existing = toNum(existingWip.total_cogm_est || existingWip.total_cogm_estimation || 0);
        const cost_variance = total_cogm_actual - total_cogm_est_existing;

        // Update work_in_process record
        const { error: updateErr } = await supabase
          .from("work_in_process")
          .update({
            processes: updatedProcesses,
            coa_finished_goods: coa_finished_goods ?? existingWip.coa_finished_goods,
            coa_defective_goods: coa_defective_goods ?? existingWip.coa_defective_goods,
            coa_expenses: coa_expenses ?? existingWip.coa_expenses,
            total_finished_goods: tf || existingWip.total_finished_goods,
            total_defective_goods: td || existingWip.total_defective_goods,
            total_expenses: te || existingWip.total_expenses,
            total_other_foc_actual: round0(total_other_foc_actual),
            total_direct_labor_actual: round0(total_direct_labor_actual),
            total_indirect_labor_actual: round0(total_indirect_labor_actual),
            total_utilities_cost_actual: round0(total_utilities_cost_actual),
            total_direct_material_actual: round0(total_direct_material_actual),
            total_indirect_material_actual: round0(total_indirect_material_actual),
            total_items_depreciation_actual: round0(total_items_depreciation_actual),
            total_foc_actual: round0(total_foc_actual),
            total_cogm_actual: round0(total_cogm_actual),
            prod_loss: round0(prod_loss),
            nett_total_cogm: round0(nett_total_cogm),
            cogm_per_unit_actual: round0(cogm_per_unit_actual),
            cost_variance: round0(cost_variance),
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);

        if (updateErr) return res.status(500).json({ error: true, message: "Failed to update work_in_process: " + updateErr.message });

        // -----------------------------
        // Create WIP Journal Entry (with validation)
        // -----------------------------
        try {
          // Validate required COAs before creating any journal header/lines
          const missing_coa = [];

          // Helper ambil amount sesuai tipe proses (use original keys, not _actual)
          const extractAmount = (item, key) => {
            if (!item) return 0;
            switch (key) {
              case "direct_material":
              case "indirect_material":
                return Number(item.total) || 0;
              case "direct_labor":
              case "indirect_labor":
              case "items_depreciation":
              case "utilities_cost":
              case "other_foc":
                return Number(item.total_est_rate) || 0;
              default:
                return 0;
            }
          };

          const processGroups = ["direct_material", "direct_labor", "indirect_material", "indirect_labor", "items_depreciation", "utilities_cost", "other_foc"];

          // Check each item that would produce a journal line: if amount > 0 and coa missing, collect it
          for (const proc of updatedProcesses) {
            for (const key of processGroups) {
              if (!Array.isArray(proc[key])) continue;
              for (const item of proc[key]) {
                const amount = extractAmount(item, key);
                if (amount > 0) {
                  if (!item || !item.coa) {
                    missing_coa.push({ process: proc.process_name || null, group: key, item_name: item?.item_name || item?.desc || null });
                  }
                }
              }
            }
          }

          // Validate WIP finished goods COA for debit
          const debitAmount = round2(total_cogm_est_existing || 0);
          if (debitAmount > 0 && !existingWip.coa_finished_goods) {
            missing_coa.push({ process: null, group: "coa_finished_goods", item_name: null });
          }

          if (missing_coa.length > 0) {
            // Do not create journal — return details so caller can fill missing COAs first
            return res.status(200).json({ error: true, message: "Missing COA data — journaling skipped", missing_coa });
          }

          // Create main journal header
          const { data: journal, error: journalError } = await supabase
            .from("journal_entries")
            .insert({
              transaction_number: `WIP-${existingWip.id}`,
              description: `Work In Process Capitalization`,
              user_id: user.id,
              entry_date: new Date().toISOString().split("T")[0],
              created_at: new Date(),
            })
            .select()
            .single();

          if (journalError || !journal) {
            console.error("Failed to create WIP journal entry:", journalError);
            return res.status(500).json({ error: true, message: "Failed to create WIP journal entry: " + (journalError && journalError.message ? journalError.message : "unknown") });
          }

          // TEMPAT MENAMPUNG CREDIT & DEBIT
          const journalLines = [];

          // Helper push credit
          const pushCredit = (coa, item_name, amount) => {
            if (!amount || amount <= 0) return;
            journalLines.push({
              journal_entry_id: journal.id,
              account_code: coa,
              description: item_name || "",
              debit: 0,
              credit: round2(amount),
              user_id: user.id,
            });
          };

          // Build credits
          for (const proc of updatedProcesses) {
            for (const key of processGroups) {
              if (!Array.isArray(proc[key])) continue;
              for (const item of proc[key]) {
                const amount = extractAmount(item, key);
                pushCredit(item.coa, item.item_name || item.desc || "", amount);
              }
            }
          }

          // Push debit line to WIP (finished goods COA)
          journalLines.push({
            journal_entry_id: journal.id,
            account_code: 130102, // WIP COA
            description: "Work In Process",
            debit: debitAmount,
            credit: 0,
            user_id: user.id,
          });

          // Insert journal lines
          const { error: journalLinesErr } = await supabase.from("journal_entry_lines").insert(journalLines);
          if (journalLinesErr) {
            console.error("Failed to insert WIP journal entry lines:", journalLinesErr);
            return res.status(500).json({ error: true, message: "Failed to insert WIP journal entry lines: " + journalLinesErr.message });
          }

          // Successful — return totals and created journal + lines (for Postman visibility)
          return res.status(200).json({
            error: false,
            message: "Work In Process updated with actuals successfully",
            data: {
              id,
              totals: {
                total_other_foc_actual: round0(total_other_foc_actual),
                total_direct_labor_actual: round0(total_direct_labor_actual),
                total_indirect_labor_actual: round0(total_indirect_labor_actual),
                total_utilities_cost_actual: round0(total_utilities_cost_actual),
                total_direct_material_actual: round0(total_direct_material_actual),
                total_indirect_material_actual: round0(total_indirect_material_actual),
                total_items_depreciation_actual: round0(total_items_depreciation_actual),
                total_foc_actual: round0(total_foc_actual),
                total_cogm_actual: round0(total_cogm_actual),
                prod_loss: round0(prod_loss),
                nett_total_cogm: round0(nett_total_cogm),
                cogm_per_unit_actual: round0(cogm_per_unit_actual),
                cost_variance: round0(cost_variance),
              },
              journal,
              journal_lines: journalLines,
            },
          });
        } catch (e) {
          console.error("WIP journal creation error:", e);
          return res.status(500).json({ error: true, message: "WIP journal creation error: " + (e.message || e) });
        }
      }

      default:
        return res.status(404).json({ error: true, message: "Endpoint not found" });
    }
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: true, message: error.message || "Unexpected server error" });
  }
};
