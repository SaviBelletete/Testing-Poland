import { useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useLang } from "@/contexts/LanguageContext";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Upload, Download, CheckCircle2, XCircle, AlertCircle, Plus, Trash2,
  RefreshCw, FileSpreadsheet, ChevronDown, ChevronUp, Pencil, Globe,
  Building2, Calendar, LayoutGrid, ArrowRight, X, History, Filter, FolderOpen
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { uploadFileInChunks, needsChunkedUpload } from "@/lib/chunkedUpload";

// ─── Safe fetch helper ───────────────────────────────────────────────────────
// Parses response as JSON safely; if the server returns plain text (e.g. "Service Unavailable")
// instead of JSON, wraps it in a proper error object so the toast shows a readable message.
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Server returned non-JSON (e.g. plain-text "Service Unavailable" from proxy/CDN)
    if (!res.ok) {
      throw new Error(
        res.status === 503
          ? "Processing engine is starting up — please wait a moment and try again."
          : `Server error (${res.status}): ${text.slice(0, 120)}`
      );
    }
    throw new Error(`Unexpected response from server: ${text.slice(0, 120)}`);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Campaign {
  id: number;
  name: string;
  clientName: string;
  originalFilename: string;
  storageKey: string;
  sheetName: string;
  sheetNames: string;
  uploadedAt: string | Date;
  lastProcessedAt: string | Date | null;
  lastRowCount: number | null;
}

interface ReconciliationResult {
  rowCountMatch: boolean;
  amountMatch: boolean;
  weeklyRowCount: number;
  addedRowCount: number;
  weeklyAmountTotal: number;
  addedAmountTotal: number;
}

interface SheetResult {
  sheetName: string;
  rowsInWeekly: number;
  rowsAdded: number;
  rowsSkipped: number;
  skippedSerials: string[];
  rowCountPass: boolean;
  amountExpected: number;
  amountActual: number;
  amountPass: boolean;
  error?: string;
}

interface ProcessResult {
  clientName: string;
  sheetName: string;
  weeklyFile: string;
  masterFile: string;
  rowsInWeekly: number;
  rowsAdded: number;
  rowsSkipped: number;
  skippedSerials: string[];
  sheetResults?: SheetResult[];
  rowCountPass: boolean;
  amountExpected: number;
  amountActual: number;
  amountPass: boolean;
}

interface PaymentFileInfo {
  label: string;
  filename: string;
  downloadKey: string;
  rowCount: number;
}

interface FilePair {
  id: string;
  campaignId: number | null;
  targetSheet: string | null;
  weeklyFile: File | null;
  masterFile: File | null;
  result: ProcessResult | null;
  downloadKey: string | null;
  downloadUrl: string | null;
  originalFilename: string | null;
  paymentFiles: PaymentFileInfo[];
  error: string | null;
  processing: boolean;
  uploadProgress: number | null; // 0-100 during chunked upload, null otherwise
}

// ─── File Drop Zone ───────────────────────────────────────────────────────────

function FileDropZone({
  label, hint, accept, file, onFile, disabled
}: {
  label: string; hint: string; accept: string;
  file: File | null; onFile: (f: File) => void; disabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { lang } = useLang();

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) onFile(dropped);
  }, [onFile]);

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      <div
        className={`relative border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all
          ${dragging ? "border-savi-green bg-savi-green/5" : "border-gray-200 hover:border-savi-teal/40 hover:bg-gray-50"}
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}
          ${file ? "border-savi-teal/50 bg-savi-teal/5" : ""}`}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={disabled ? undefined : handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          disabled={disabled}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
        />
        {file ? (
          <div className="flex items-center justify-center gap-2 text-savi-teal">
            <FileSpreadsheet size={18} />
            <span className="text-sm font-medium truncate max-w-[200px]">{file.name}</span>
            <CheckCircle2 size={16} className="text-savi-green flex-shrink-0" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 text-gray-400">
            <Upload size={20} />
            <span className="text-xs">{dragging ? t(lang, "dropActive") : t(lang, "dropHere")}</span>
          </div>
        )}
      </div>
      {hint && <p className="text-xs text-gray-400">{hint}</p>}
    </div>
  );
}

// ─── Reconciliation Badge ─────────────────────────────────────────────────────

function ReconciliationBadge({ pass }: { pass: boolean }) {
  const { lang } = useLang();
  return pass ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700">
      <CheckCircle2 size={12} /> {t(lang, "resultPass")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">
      <XCircle size={12} /> {t(lang, "resultFail")}
    </span>
  );
}

// ─── Per-Sheet Result Row ─────────────────────────────────────────────────────

function SheetResultRow({ sr }: { sr: SheetResult }) {
  const { lang } = useLang();
  const [showSkipped, setShowSkipped] = useState(false);
  const pass = sr.rowCountPass && sr.amountPass;

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${pass ? "border-green-200 bg-green-50/20" : "border-red-200 bg-red-50/20"}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-savi-teal" />
          <span className="font-semibold text-sm text-gray-800">{sr.sheetName}</span>
          {pass
            ? <span className="inline-flex items-center gap-1 text-xs font-bold text-green-700"><CheckCircle2 size={12} /> {t(lang, "resultPass")}</span>
            : <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700"><XCircle size={12} /> {t(lang, "resultFail")}</span>
          }
          {sr.error && <span className="text-xs text-red-600 truncate max-w-xs">{sr.error}</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="text-gray-700 font-medium">{sr.rowsAdded} {t(lang, "resultRowsAdded").toLowerCase()}</span>
          {sr.rowsSkipped > 0 && <span className="text-amber-600">{sr.rowsSkipped} {t(lang, "resultRowsSkipped").toLowerCase()}</span>}
          <span className="text-gray-400">{(sr.amountActual ?? 0).toFixed(2)}</span>
        </div>
      </div>
      {sr.rowsSkipped > 0 && (
        <div>
          <button
            className="flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 font-medium"
            onClick={() => setShowSkipped(!showSkipped)}
          >
            {showSkipped ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {t(lang, "resultSkippedSerials")} ({sr.rowsSkipped})
          </button>
          {showSkipped && (
            <div className="mt-1 max-h-24 overflow-y-auto bg-amber-50 rounded-lg p-2 border border-amber-100">
              <div className="flex flex-wrap gap-1">
                {sr.skippedSerials.map(s => (
                  <span key={s} className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-mono">{s}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Payment Files Section ───────────────────────────────────────────────────

function PaymentFilesSection({ files }: { files: PaymentFileInfo[] }) {
  const { lang } = useLang();

  const handleDownload = (pf: PaymentFileInfo) => {
    const url = `/api/download?key=${encodeURIComponent(pf.downloadKey)}&filename=${encodeURIComponent(pf.filename)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = pf.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-100 p-4 space-y-3">
      <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
        <Download size={14} className="text-savi-teal" />
        {t(lang, "resultPaymentFiles")}
      </h4>
      {files.length === 0 ? (
        <p className="text-xs text-gray-400">{t(lang, "resultPaymentFilesEmpty")}</p>
      ) : (
        <div className="space-y-2">
          {files.map((pf) => (
            <div
              key={pf.downloadKey}
              className="flex items-center justify-between gap-3 p-2 rounded-lg bg-gray-50 border border-gray-100"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FileSpreadsheet size={14} className="text-savi-teal flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{pf.label}</p>
                  <p className="text-xs text-gray-400 truncate">{pf.filename} &middot; {pf.rowCount} {t(lang, "resultPaymentFileRows")}</p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleDownload(pf)}
                className="flex-shrink-0 text-savi-teal border-savi-teal/30 hover:bg-savi-teal/5"
              >
                <Download size={12} className="mr-1" />
                {t(lang, "resultPaymentFileDownload")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Result Card ──────────────────────────────────────────────────────────────

function ResultCard({ pair }: { pair: FilePair }) {
  const { lang } = useLang();
  const r = pair.result!;
  const allPass = r.rowCountPass && r.amountPass;
  const hasSheetResults = r.sheetResults && r.sheetResults.length > 0;
  const sheetsProcessed = r.sheetResults?.length ?? 1;

  const handleDownload = () => {
    if (!pair.downloadKey) return;
    const url = `/api/download?key=${encodeURIComponent(pair.downloadKey)}&filename=${encodeURIComponent(pair.originalFilename || "master.xlsm")}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = pair.originalFilename || "master.xlsm";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className={`rounded-xl border-2 p-5 space-y-4 ${allPass ? "border-green-200 bg-green-50/30" : "border-red-200 bg-red-50/30"}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-savi-teal">{r.clientName}</span>
            <Badge variant="outline" className="text-xs">
              {hasSheetResults ? `${sheetsProcessed} ${t(lang, "resultCountries")}` : r.sheetName}
            </Badge>
            {allPass
              ? <span className="inline-flex items-center gap-1 text-xs font-bold text-green-700"><CheckCircle2 size={14} /> {t(lang, "resultSuccess")}</span>
              : <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700"><XCircle size={14} /> {t(lang, "resultError")}</span>
            }
          </div>
          <p className="text-xs text-gray-500 mt-1 truncate max-w-xs">{r.weeklyFile}</p>
        </div>
        {pair.downloadKey && (
          <Button size="sm" onClick={handleDownload} className="bg-savi-teal hover:bg-savi-teal/90 text-white flex-shrink-0">
            <Download size={14} className="mr-1" /> {t(lang, "resultDownload")}
          </Button>
        )}
      </div>

      {/* Aggregate stats grid */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: t(lang, "resultRowsInWeekly"), value: r.rowsInWeekly, color: "text-gray-700" },
          { label: t(lang, "resultRowsAdded"), value: r.rowsAdded, color: "text-green-700" },
          { label: t(lang, "resultRowsSkipped"), value: r.rowsSkipped, color: "text-amber-600" },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-white rounded-lg p-3 border border-gray-100 text-center">
            <div className={`text-2xl font-bold ${color}`}>{value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Per-country breakdown */}
      {hasSheetResults && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
            <LayoutGrid size={14} className="text-savi-teal" />
            {t(lang, "resultPerCountry")}
          </h4>
          {r.sheetResults!.map(sr => (
            <SheetResultRow key={sr.sheetName} sr={sr} />
          ))}
        </div>
      )}

      {/* Aggregate reconciliation */}
      <div className="bg-white rounded-lg border border-gray-100 p-4 space-y-3">
        <h4 className="text-sm font-semibold text-gray-700">{t(lang, "resultReconciliation")}</h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">{t(lang, "resultRowCount")}</span>
            <div className="flex items-center gap-3">
              <span className="text-gray-400 text-xs">{t(lang, "resultExpected")}: {r.rowsInWeekly - r.rowsSkipped} / {t(lang, "resultActual")}: {r.rowsAdded}</span>
              <ReconciliationBadge pass={r.rowCountPass} />
            </div>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">{t(lang, "resultAmountCheck")}</span>
            <div className="flex items-center gap-3">
              <span className="text-gray-400 text-xs">
                {t(lang, "resultExpected")}: {(r.amountExpected ?? 0).toFixed(2)} / {t(lang, "resultActual")}: {(r.amountActual ?? 0).toFixed(2)}
              </span>
              <ReconciliationBadge pass={r.amountPass} />
            </div>
          </div>
        </div>
      </div>

      {/* Payment instruction files */}
      <PaymentFilesSection files={pair.paymentFiles} />
    </div>
  );
}

// ─── Master File Row ─────────────────────────────────────────────────────────

function MasterFileRow({ campaign }: { campaign: Campaign }) {
  const { lang } = useLang();

  const handleDownload = () => {
    const url = `/api/download?key=${encodeURIComponent(campaign.storageKey)}&filename=${encodeURIComponent(campaign.originalFilename)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = campaign.originalFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const lastUpdated = campaign.lastProcessedAt
    ? new Date(campaign.lastProcessedAt).toLocaleDateString()
    : campaign.uploadedAt
      ? new Date(campaign.uploadedAt).toLocaleDateString()
      : "—";

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-5 py-3 font-medium text-gray-900">{campaign.name}</td>
      <td className="px-5 py-3 text-gray-600">{campaign.clientName}</td>
      <td className="px-5 py-3 text-gray-500 text-xs font-mono truncate max-w-[180px]">{campaign.originalFilename}</td>
      <td className="px-5 py-3 text-gray-500">{lastUpdated}</td>
      <td className="px-5 py-3 text-center">
        <Button
          size="sm"
          onClick={handleDownload}
          className="bg-savi-teal hover:bg-savi-teal/90 text-white"
        >
          <Download size={13} className="mr-1" /> {t(lang, "masterFilesDownload")}
        </Button>
      </td>
    </tr>
  );
}

// ─── Campaign Card ────────────────────────────────────────────────────────────

function CampaignCard({
  campaign, onRefresh
}: { campaign: Campaign; onRefresh: () => void }) {
  const { lang } = useLang();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(campaign.name);
  const [replacing, setReplacing] = useState(false);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownloadMaster = () => {
    const url = `/api/download?key=${encodeURIComponent(campaign.storageKey)}&filename=${encodeURIComponent(campaign.originalFilename)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = campaign.originalFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const renameMutation = trpc.campaigns.rename.useMutation({
    onSuccess: () => { setRenaming(false); onRefresh(); toast.success(t(lang, "toastCampaignRenamed")); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMutation = trpc.campaigns.delete.useMutation({
    onSuccess: () => { onRefresh(); toast.success(t(lang, "toastCampaignDeleted")); },
    onError: (e) => toast.error(e.message),
  });

  const handleReplace = async () => {
    if (!replaceFile) return;
    setLoading(true);
    try {
      let res: Response;
      if (needsChunkedUpload(replaceFile)) {
        const uploadId = await uploadFileInChunks(replaceFile, "masterFile");
        res = await fetch("/api/finalize-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "replace-campaign-master",
            uploadIds: { masterFile: uploadId },
            filenames: { masterFile: replaceFile.name },
            campaignId: campaign.id,
          }),
        });
      } else {
        const fd = new FormData();
        fd.append("masterFile", replaceFile);
        fd.append("campaignId", String(campaign.id));
        res = await fetch("/api/replace-campaign-master", { method: "POST", body: fd });
      }
      if (!res.ok) throw new Error((await safeJson(res)).error);
      toast.success(t(lang, "toastMasterReplaced"));
      setReplacing(false);
      setReplaceFile(null);
      onRefresh();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  const uploadedDate = campaign.uploadedAt ? new Date(campaign.uploadedAt).toLocaleDateString() : "—";
  const lastProcessed = campaign.lastProcessedAt
    ? new Date(campaign.lastProcessedAt).toLocaleDateString()
    : t(lang, "campaignNeverProcessed");

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4 hover:shadow-md transition-shadow">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-savi-teal/30"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") renameMutation.mutate({ id: campaign.id, name: newName }); if (e.key === "Escape") setRenaming(false); }}
                autoFocus
              />
              <Button size="sm" onClick={() => renameMutation.mutate({ id: campaign.id, name: newName })} className="bg-savi-teal text-white h-8">{t(lang, "campaignRenameSave")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(false)} className="h-8">{t(lang, "campaignRenameCancel")}</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-gray-900 truncate">{campaign.name}</h3>
              <button onClick={() => setRenaming(true)} className="text-gray-400 hover:text-savi-teal transition-colors">
                <Pencil size={14} />
              </button>
            </div>
          )}
          <p className="text-xs text-gray-400 mt-0.5 truncate">{campaign.originalFilename}</p>
        </div>
        <button onClick={() => setDeleteOpen(true)} className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0">
          <Trash2 size={16} />
        </button>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-gray-400 mb-0.5">{t(lang, "campaignClient")}</div>
          <div className="font-medium text-gray-700">{campaign.clientName}</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-gray-400 mb-0.5">{t(lang, "campaignSheet")}</div>
          <div className="font-medium text-gray-700">{campaign.sheetName || "—"}</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-gray-400 mb-0.5">{t(lang, "campaignUploaded")}</div>
          <div className="font-medium text-gray-700">{uploadedDate}</div>
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5">
          <div className="text-gray-400 mb-0.5">{t(lang, "campaignLastProcessed")}</div>
          <div className={`font-medium ${campaign.lastProcessedAt ? "text-gray-700" : "text-gray-400"}`}>{lastProcessed}</div>
        </div>
      </div>

      {campaign.lastRowCount != null && campaign.lastRowCount > 0 && (
        <div className="text-xs text-gray-500 text-center">
          {campaign.lastRowCount} {t(lang, "campaignRows")} {t(lang, "campaignLastProcessed").toLowerCase()}
        </div>
      )}

      {/* Download + Replace master */}
      <div className="flex items-center gap-2 mb-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleDownloadMaster}
          disabled={downloading}
          className="flex-1 border-savi-teal/40 text-savi-teal hover:bg-savi-teal/5 bg-transparent"
        >
          {downloading
            ? <><RefreshCw size={13} className="animate-spin mr-1" /> {t(lang, "campaignDownloading")}</>
            : <><Download size={13} className="mr-1" /> {t(lang, "campaignDownloadMaster")}</>}
        </Button>
      </div>
      <div>
        <button
          className="text-xs text-savi-teal hover:underline flex items-center gap-1"
          onClick={() => setReplacing(!replacing)}
        >
          <RefreshCw size={12} /> {t(lang, "campaignReplace")}
        </button>
        {replacing && (
          <div className="mt-3 space-y-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <p className="text-xs text-gray-500">{t(lang, "campaignReplaceHint")}</p>
            <FileDropZone
              label={t(lang, "campaignReplaceLabel")}
              hint=""
              accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.ms-excel"
              file={replaceFile}
              onFile={setReplaceFile}
            />
            {replaceFile && (
              <Button size="sm" onClick={handleReplace} disabled={loading} className="w-full bg-savi-teal text-white">
                {loading ? <><RefreshCw size={14} className="animate-spin mr-1" /> {t(lang, "campaignUploading")}</> : t(lang, "campaignReplace")}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Delete dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(lang, "campaignDelete")}</AlertDialogTitle>
            <AlertDialogDescription>{t(lang, "campaignDeleteConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(lang, "cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => deleteMutation.mutate({ id: campaign.id })}
            >
              {t(lang, "delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Upload New Campaign ──────────────────────────────────────────────────────

function UploadCampaignPanel({ onSuccess }: { onSuccess: () => void }) {
  const { lang } = useLang();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [detected, setDetected] = useState<{ clientName: string; sheetName: string } | null>(null);
  const [detectingSheets, setDetectingSheets] = useState(false);
  const refreshSheets = trpc.campaigns.refreshSheets.useMutation();
  const utils = trpc.useUtils();

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    try {
      let res: Response;
      if (needsChunkedUpload(file)) {
        const uploadId = await uploadFileInChunks(file, "masterFile");
        res = await fetch("/api/finalize-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "upload-campaign",
            uploadIds: { masterFile: uploadId },
            filenames: { masterFile: file.name },
          }),
        });
      } else {
        const fd = new FormData();
        fd.append("masterFile", file);
        res = await fetch("/api/upload-campaign", { method: "POST", body: fd });
      }
      const data = await safeJson(res);
      if (res.status === 409) {
        // Duplicate campaign — show a specific, actionable error
        toast.error(data.error, { duration: 8000 });
        return;
      }
      if (!res.ok) throw new Error(data.error);
      setDetected({ clientName: data.clientName, sheetName: data.sheetName });
      toast.success(`Campaign created: ${data.name}`);
      setFile(null);
      onSuccess();

      // If the worker was cold-starting, sheetNames may be empty.
      // Poll refreshSheets in the background until the worker populates them.
      if (!data.sheetNames || data.sheetNames.length === 0) {
        setDetectingSheets(true);
        let attempts = 0;
        const maxAttempts = 10;
        const poll = async () => {
          attempts++;
          try {
            const result = await refreshSheets.mutateAsync({ id: data.id });
            if (result.ready) {
              setDetected({ clientName: data.clientName, sheetName: result.sheetName });
              await utils.campaigns.list.invalidate();
              setDetectingSheets(false);
              return;
            }
          } catch { /* worker still starting */ }
          if (attempts < maxAttempts) {
            setTimeout(poll, 3000);
          } else {
            setDetectingSheets(false);
          }
        };
        setTimeout(poll, 3000);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border-2 border-dashed border-savi-teal/30 p-6 space-y-4">
      <h3 className="font-semibold text-savi-teal flex items-center gap-2">
        <Plus size={18} /> {t(lang, "campaignUploadNew")}
      </h3>
      <FileDropZone
        label={t(lang, "campaignUploadMasterLabel")}
        hint={t(lang, "campaignUploadMasterHint")}
        accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.ms-excel"
        file={file}
        onFile={setFile}
      />
      {file && (
        <Button onClick={handleUpload} disabled={loading} className="w-full bg-savi-teal hover:bg-savi-teal/90 text-white">
          {loading
            ? <><RefreshCw size={16} className="animate-spin mr-2" /> {t(lang, "campaignUploading")}</>
            : <><Upload size={16} className="mr-2" /> {t(lang, "campaignUploadBtn")}</>
          }
        </Button>
      )}
      {detected && (
        <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 rounded-lg p-3 border border-green-200">
          <CheckCircle2 size={16} />
          <span>{t(lang, "campaignDetected")}: <strong>{detected.clientName}</strong>{detected.sheetName ? ` — ${detected.sheetName}` : ""}</span>
        </div>
      )}
      {detectingSheets && (
        <div className="flex items-center gap-2 text-sm text-savi-teal bg-savi-teal/5 rounded-lg p-3 border border-savi-teal/20">
          <RefreshCw size={16} className="animate-spin" />
          <span>Detecting sheet names… this may take a few seconds on first upload.</span>
        </div>
      )}
    </div>
  );
}

// ─── Process Panel ────────────────────────────────────────────────────────────

function ProcessPanel({ campaigns }: { campaigns: Campaign[] }) {
  const { lang } = useLang();
  const [pairs, setPairs] = useState<FilePair[]>([
    { id: "1", campaignId: null, targetSheet: null, weeklyFile: null, masterFile: null, result: null, downloadKey: null, downloadUrl: null, originalFilename: null, paymentFiles: [], error: null, processing: false, uploadProgress: null }
  ]);
  const [processingAll, setProcessingAll] = useState(false);

  const updatePair = (id: string, update: Partial<FilePair>) => {
    setPairs(prev => prev.map(p => p.id === id ? { ...p, ...update } : p));
  };

  const addPair = () => {
    setPairs(prev => [...prev, {
      id: String(Date.now()), campaignId: null, targetSheet: null, weeklyFile: null, masterFile: null,
      result: null, downloadKey: null, downloadUrl: null, originalFilename: null, paymentFiles: [], error: null, processing: false, uploadProgress: null
    }]);
  };

  const removePair = (id: string) => {
    setPairs(prev => prev.filter(p => p.id !== id));
  };

  const processPair = async (pair: FilePair): Promise<void> => {
    if (!pair.weeklyFile) { toast.error(t(lang, "toastWeeklyRequired")); return; }
    if (!pair.campaignId && !pair.masterFile) { toast.error(t(lang, "toastCampaignOrMasterRequired")); return; }

    updatePair(pair.id, { processing: true, error: null, result: null, uploadProgress: null });
    try {
      const largeFiles = [
        pair.weeklyFile && needsChunkedUpload(pair.weeklyFile) ? pair.weeklyFile : null,
        pair.masterFile && needsChunkedUpload(pair.masterFile) ? pair.masterFile : null,
      ].filter(Boolean);

      if (largeFiles.length > 0) {
        // Chunked upload path for large files
        const uploadIds: Record<string, string> = {};
        const filenames: Record<string, string> = {};

        // Track combined progress across weekly + master uploads
        const fileList: Array<{ file: File; field: string }> = [];
        if (needsChunkedUpload(pair.weeklyFile!)) fileList.push({ file: pair.weeklyFile!, field: "weeklyFile" });
        if (pair.masterFile && needsChunkedUpload(pair.masterFile)) fileList.push({ file: pair.masterFile, field: "masterFile" });

        let totalChunks = 0;
        let doneChunks = 0;
        const CHUNK_SIZE = 4 * 1024 * 1024;
        fileList.forEach(({ file }) => { totalChunks += Math.ceil(file.size / CHUNK_SIZE); });

        for (const { file, field } of fileList) {
          const id = await uploadFileInChunks(file, field, (pct) => {
            const fileChunks = Math.ceil(file.size / CHUNK_SIZE);
            const fileDone = Math.round((pct / 100) * fileChunks);
            const overall = Math.round(((doneChunks + fileDone) / totalChunks) * 100);
            updatePair(pair.id, { uploadProgress: overall });
          });
          doneChunks += Math.ceil(file.size / CHUNK_SIZE);
          uploadIds[field] = id;
          filenames[field] = file.name;
        }

        // Non-chunked files still go via FormData in the finalize body
        if (!uploadIds["weeklyFile"]) {
          // weekly is small — upload as single chunk
          const id = await uploadFileInChunks(pair.weeklyFile!, "weeklyFile");
          uploadIds["weeklyFile"] = id;
          filenames["weeklyFile"] = pair.weeklyFile!.name;
        }
        if (pair.masterFile && !uploadIds["masterFile"]) {
          const id = await uploadFileInChunks(pair.masterFile, "masterFile");
          uploadIds["masterFile"] = id;
          filenames["masterFile"] = pair.masterFile.name;
        }

        updatePair(pair.id, { uploadProgress: 100 });

        const res = await fetch("/api/finalize-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "process-payments",
            uploadIds,
            filenames,
            campaignId: pair.campaignId ?? undefined,
            masterSheet: pair.targetSheet ?? undefined,
          }),
        });
        const data = await safeJson(res);
        if (!res.ok) throw new Error(data.error);
        updatePair(pair.id, {
          result: data.result,
          downloadKey: data.downloadKey,
          downloadUrl: data.downloadUrl,
          originalFilename: data.originalFilename,
          paymentFiles: Array.isArray(data.paymentFiles) ? data.paymentFiles : [],
          processing: false,
          uploadProgress: null,
        });
        toast.success(`${data.result.clientName}: ${data.result.rowsAdded} rows added`);
      } else {
        // Normal single-request path for small files
        const fd = new FormData();
        fd.append("weeklyFile", pair.weeklyFile!);
        if (pair.campaignId) fd.append("campaignId", String(pair.campaignId));
        if (pair.masterFile) fd.append("masterFile", pair.masterFile);
        if (pair.targetSheet) fd.append("targetSheet", pair.targetSheet);

        const res = await fetch("/api/process-payments", { method: "POST", body: fd });
        const data = await safeJson(res);
        if (!res.ok) throw new Error(data.error);

        updatePair(pair.id, {
          result: data.result,
          downloadKey: data.downloadKey,
          downloadUrl: data.downloadUrl,
          originalFilename: data.originalFilename,
          paymentFiles: Array.isArray(data.paymentFiles) ? data.paymentFiles : [],
          processing: false,
          uploadProgress: null,
        });
        toast.success(`${data.result.clientName}: ${data.result.rowsAdded} rows added`);
      }
    } catch (e: any) {
      updatePair(pair.id, { error: e.message, processing: false, uploadProgress: null });
      toast.error(e.message);
    }
  };

  const processAll = async () => {
    setProcessingAll(true);
    for (const pair of pairs) {
      await processPair(pair);
    }
    setProcessingAll(false);
  };

  return (
    <div className="space-y-6">
      {pairs.map((pair, idx) => (
        <div key={pair.id} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
          {/* Pair header */}
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <FileSpreadsheet size={18} className="text-savi-teal" />
              {t(lang, "tabProcess")} {pairs.length > 1 ? `#${idx + 1}` : ""}
            </h3>
            {pairs.length > 1 && (
              <button onClick={() => removePair(pair.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                <X size={18} />
              </button>
            )}
          </div>

          {/* Campaign selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">{t(lang, "processSelectCampaign")}</label>
            <select
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-savi-teal/30 focus:border-savi-teal/50"
              value={pair.campaignId ?? ""}
              onChange={e => updatePair(pair.id, { campaignId: e.target.value ? parseInt(e.target.value) : null, masterFile: null })}
            >
              <option value="">{t(lang, "processSelectCampaignPlaceholder")}</option>
              {campaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.clientName})</option>
              ))}
            </select>
            {pair.campaignId && (() => {
              const selectedCampaign = campaigns.find(c => c.id === pair.campaignId);
              const sheetNames: string[] = selectedCampaign?.sheetNames
                ? (typeof selectedCampaign.sheetNames === 'string'
                    ? JSON.parse(selectedCampaign.sheetNames)
                    : selectedCampaign.sheetNames)
                : [];
              return (
                <div className="flex items-center gap-2 text-xs text-savi-teal bg-savi-teal/5 rounded-lg px-3 py-2 border border-savi-teal/20">
                  <CheckCircle2 size={14} />
                  <span>
                    <strong>{selectedCampaign?.originalFilename}</strong>
                    {sheetNames.length > 0
                      ? <> — <Globe size={11} className="inline mb-0.5" /> {sheetNames.length} country sheets will be processed automatically</>  
                      : <> — {t(lang, "historySheet")}: <strong>{selectedCampaign?.sheetName}</strong></>}
                  </span>
                </div>
              );
            })()}
          </div>

          {/* Manual master upload (only if no campaign selected) */}
          {!pair.campaignId && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <div className="flex-1 h-px bg-gray-200" />
                <span>{t(lang, "processOrUploadMaster")}</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>
              <FileDropZone
                label={t(lang, "processMasterLabel")}
                hint={t(lang, "processMasterHint")}
                accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.ms-excel"
                file={pair.masterFile}
                onFile={f => updatePair(pair.id, { masterFile: f })}
              />
            </div>
          )}

          {/* Weekly file */}
          <FileDropZone
            label={t(lang, "processWeeklyLabel")}
            hint={t(lang, "processWeeklyHint")}
            accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.ms-excel"
            file={pair.weeklyFile}
            onFile={f => updatePair(pair.id, { weeklyFile: f })}
          />

          {/* Process button */}
          <Button
            onClick={() => processPair(pair)}
            disabled={pair.processing || processingAll || !pair.weeklyFile || (!pair.campaignId && !pair.masterFile)}
            className="w-full bg-savi-teal hover:bg-savi-teal/90 text-white font-semibold py-2.5"
          >
            {pair.processing
              ? <><RefreshCw size={16} className="animate-spin mr-2" /> {t(lang, "processing")}</>
              : <><ArrowRight size={16} className="mr-2" /> {t(lang, "processBtn")}</>
            }
          </Button>

          {/* Upload progress (chunked upload for large files) */}
          {pair.uploadProgress !== null && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-gray-500">
                <span>Uploading file2026</span>
                <span>{pair.uploadProgress}%</span>
              </div>
              <Progress value={pair.uploadProgress} className="h-2" />
            </div>
          )}
          {/* Error */}
          {pair.error && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded-lg p-3 border border-red-200">
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              <span>{pair.error}</span>
            </div>
          )}

          {/* Result */}
          {pair.result && <ResultCard pair={pair} />}
        </div>
      ))}

      {/* Add pair + Process all */}
      <div className="flex gap-3">
        <Button variant="outline" onClick={addPair} className="flex-1 border-dashed border-savi-teal/40 text-savi-teal hover:bg-savi-teal/5">
          <Plus size={16} className="mr-2" /> {t(lang, "processAddPair")}
        </Button>
        {pairs.length > 1 && (
          <Button
            onClick={processAll}
            disabled={processingAll}
            className="flex-1 bg-savi-teal hover:bg-savi-teal/90 text-white"
          >
            {processingAll
              ? <><RefreshCw size={16} className="animate-spin mr-2" /> {t(lang, "processing")}</>
              : t(lang, "processBtnAll")
            }
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Main Home Page ───────────────────────────────────────────────────────────

// ─── History Row Component ───────────────────────────────────────────────────
function HistoryRow({ run }: { run: any }) {
  const { lang } = useLang();

  const handleDownload = () => {
    if (!run.downloadKey) return;
    const filename = run.masterFilename || "master.xlsm";
    const url = `/api/download?key=${encodeURIComponent(run.downloadKey)}&filename=${encodeURIComponent(filename)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const rowPass = run.rowCountPass === 1;
  const amtPass = run.amountPass === 1;
  const date = run.processedAt ? new Date(run.processedAt).toLocaleString() : "—";

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-gray-600 whitespace-nowrap text-xs">{date}</td>
      <td className="px-4 py-3 font-medium text-gray-800 max-w-[160px] truncate">{run.campaignName}</td>
      <td className="px-4 py-3 text-gray-600">
        <span className="bg-savi-teal/10 text-savi-teal px-2 py-0.5 rounded-full text-xs font-medium">{run.sheetName || "—"}</span>
      </td>
      <td className="px-4 py-3 text-gray-500 text-xs max-w-[180px] truncate" title={run.weeklyFilename}>{run.weeklyFilename}</td>
      <td className="px-4 py-3 text-center">
        <span className="font-bold text-savi-teal">{run.rowsAdded ?? 0}</span>
      </td>
      <td className="px-4 py-3 text-center">
        <span className="text-gray-400">{run.rowsSkipped ?? 0}</span>
      </td>
      <td className="px-4 py-3 text-center">
        {rowPass
          ? <span className="inline-flex items-center gap-1 text-green-600 bg-green-50 px-2 py-0.5 rounded-full text-xs font-semibold"><CheckCircle2 size={12} /> {t(lang, "resultPass")}</span>
          : <span className="inline-flex items-center gap-1 text-red-500 bg-red-50 px-2 py-0.5 rounded-full text-xs font-semibold"><XCircle size={12} /> {t(lang, "resultFail")}</span>
        }
      </td>
      <td className="px-4 py-3 text-center">
        {amtPass
          ? <span className="inline-flex items-center gap-1 text-green-600 bg-green-50 px-2 py-0.5 rounded-full text-xs font-semibold"><CheckCircle2 size={12} /> {t(lang, "resultPass")}</span>
          : <span className="inline-flex items-center gap-1 text-red-500 bg-red-50 px-2 py-0.5 rounded-full text-xs font-semibold"><XCircle size={12} /> {t(lang, "resultFail")}</span>
        }
      </td>
      <td className="px-4 py-3 text-center">
        {run.downloadKey ? (
          <button
            onClick={handleDownload}
            className="inline-flex items-center gap-1 text-savi-teal hover:text-savi-teal/70 transition-colors text-xs font-medium"
          >
            <Download size={14} /> {t(lang, "historyDownload")}
          </button>
        ) : (
          <span className="text-gray-300 text-xs">{t(lang, "historyNoDownload")}</span>
        )}
      </td>
    </tr>
  );
}

export default function Home() {
  const { lang, toggle } = useLang();
  const [workerOnline, setWorkerOnline] = useState<boolean | null>(null);
  const [activeTab, setActiveTab] = useState("process");
  const [historyFilter, setHistoryFilter] = useState<number | null>(null);
  const [exportingCsv, setExportingCsv] = useState(false);
  const { data: campaignData, refetch: refetchCampaigns, isLoading: campaignsLoading } = trpc.campaigns.list.useQuery();
  const campaigns: Campaign[] = (campaignData || []) as Campaign[];
  const { data: historyData, isLoading: historyLoading, refetch: refetchHistory } = trpc.history.list.useQuery({ limit: 200 });
  const historyRuns = (historyData || []) as any[];
  const filteredRuns = historyFilter ? historyRuns.filter((r: any) => r.campaignId === historyFilter) : historyRuns;

  const handleExportCsv = () => {
    if (filteredRuns.length === 0) { toast.error(t(lang, "historyExportEmpty")); return; }
    setExportingCsv(true);
    try {
      const headers = [
        t(lang, "csvHeaderDate"),
        t(lang, "csvHeaderCampaign"),
        t(lang, "csvHeaderSheet"),
        t(lang, "csvHeaderWeeklyFile"),
        t(lang, "csvHeaderAdded"),
        t(lang, "csvHeaderSkipped"),
        t(lang, "csvHeaderRowCheck"),
        t(lang, "csvHeaderExpAmount"),
        t(lang, "csvHeaderActAmount"),
        t(lang, "csvHeaderAmountCheck"),
      ];
      const rows = filteredRuns.map((r: any) => [
        new Date(r.processedAt).toLocaleString(),
        r.campaignName || "",
        r.sheetName || "",
        r.weeklyFilename || "",
        r.rowsAdded ?? 0,
        r.rowsSkipped ?? 0,
        r.rowCountPass ? "PASS" : "FAIL",
        r.amountExpected != null ? Number(r.amountExpected).toFixed(2) : "",
        r.amountActual != null ? Number(r.amountActual).toFixed(2) : "",
        r.amountPass ? "PASS" : "FAIL",
      ]);
      const csv = [headers, ...rows].map(row => row.map((v: any) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `processing_history_${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExportingCsv(false);
    }
  };

  // Check worker health — retry up to 3 times with 3s gaps.
  // If the first attempt fails (cold start), show a brief toast and keep retrying.
  useEffect(() => {
    let cancelled = false;
    let toastShown = false;

    const check = async (attempt: number) => {
      try {
        const r = await fetch("/api/worker-health");
        const d = await r.json();
        if (!cancelled) {
          const ok = d.workerStatus === "ok";
          setWorkerOnline(ok);
          // If we previously showed the toast and it's now back, dismiss it
          // (sonner auto-dismisses; no explicit action needed)
        }
      } catch {
        if (!cancelled) {
          setWorkerOnline(false);
          // Show a toast only on the first failure, not on every retry
          if (!toastShown) {
            toastShown = true;
            toast(t(lang, "workerOfflineToast"), {
              duration: 5000,
              id: "worker-offline",
            });
          }
          // Retry up to 3 times
          if (attempt < 3) {
            setTimeout(() => { if (!cancelled) check(attempt + 1); }, 3000);
          }
        }
      }
    };

    check(1);
    return () => { cancelled = true; };
  }, [lang]);

  const logoUrl = "/manus-storage/savi_logo_white_a1b2c3d4.png";

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-savi-teal text-white shadow-lg">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <img
              src="https://savispain.es/wp-content/uploads/2022/03/savi-logo-blanco.svg"
              alt="Savi"
              className="h-8 object-contain"
              onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <div className="hidden sm:block h-6 w-px bg-white/30" />
            <div className="hidden sm:block">
              <div className="font-bold text-lg leading-tight">{t(lang, "appTitle")}</div>
              <div className="text-xs text-white/70">{t(lang, "appSubtitle")}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Worker status — show green badge always so users have confidence; hide only when null (loading) */}
            {workerOnline !== null && (
              <div className={`hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full transition-all ${
                workerOnline
                  ? "bg-savi-green/20 text-savi-green"
                  : "bg-red-400/20 text-red-300"
              }`}>
                <div className={`w-1.5 h-1.5 rounded-full ${workerOnline ? "bg-savi-green animate-pulse" : "bg-red-400"}`} />
                {workerOnline ? t(lang, "workerOnline") : t(lang, "workerOffline")}
              </div>
            )}
            {/* Language toggle */}
            <button
              onClick={toggle}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors text-sm font-medium"
            >
              <Globe size={15} />
              {t(lang, "langSwitch")}
            </button>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-5xl mx-auto px-4 py-8">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6 bg-white border border-gray-200 p-1 rounded-xl shadow-sm">
            <TabsTrigger value="process" className="savi-tab flex items-center gap-2 rounded-lg px-5 py-2 font-medium">
              <FileSpreadsheet size={16} /> {t(lang, "tabProcess")}
            </TabsTrigger>
            <TabsTrigger value="campaigns" className="savi-tab flex items-center gap-2 rounded-lg px-5 py-2 font-medium">
              <LayoutGrid size={16} /> {t(lang, "tabCampaigns")}
              {campaigns.length > 0 && (
                <span className="ml-1 bg-savi-green/80 text-savi-teal text-xs font-bold px-1.5 py-0.5 rounded-full">{campaigns.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" className="savi-tab flex items-center gap-2 rounded-lg px-5 py-2 font-medium" onClick={() => refetchHistory()}>
              <History size={16} /> {t(lang, "tabHistory")}
              {historyRuns.length > 0 && (
                <span className="ml-1 bg-savi-green/80 text-savi-teal text-xs font-bold px-1.5 py-0.5 rounded-full">{historyRuns.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="masterfiles" className="savi-tab flex items-center gap-2 rounded-lg px-5 py-2 font-medium">
              <FolderOpen size={16} /> {t(lang, "tabMasterFiles")}
            </TabsTrigger>
          </TabsList>

          {/* Process tab */}
          <TabsContent value="process">
            <div className="mb-4">
              <h2 className="text-xl font-bold text-gray-900">{t(lang, "processTitle")}</h2>
              <p className="text-sm text-gray-500 mt-1">{t(lang, "processSubtitle")}</p>
              {campaigns.length === 0 && (
                <div className="mt-3 flex items-center gap-2 text-sm text-amber-700 bg-amber-50 rounded-lg px-4 py-3 border border-amber-200">
                  <AlertCircle size={16} className="flex-shrink-0" />
                  <span>
                    {t(lang, "noCampaignHelperMsg")}{" "}
                    <button className="underline font-medium" onClick={() => setActiveTab("campaigns")}>
                      {t(lang, "noCampaignHelperLink")}
                    </button>{" "}
                    {t(lang, "noCampaignHelperSuffix")}
                  </span>
                </div>
              )}
            </div>
            <ProcessPanel campaigns={campaigns} />
          </TabsContent>

          {/* History tab */}
          <TabsContent value="history">
            <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-gray-900">{t(lang, "historyTitle")}</h2>
                <p className="text-sm text-gray-500 mt-1">{t(lang, "historySubtitle")}</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {campaigns.length > 0 && (
                  <>
                    <Filter size={14} className="text-gray-400" />
                    <select
                      className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-savi-teal/30"
                      value={historyFilter ?? ""}
                      onChange={e => setHistoryFilter(e.target.value ? parseInt(e.target.value) : null)}
                    >
                      <option value="">{t(lang, "historyFilterAll")}</option>
                      {campaigns.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </>
                )}
                <button
                  onClick={handleExportCsv}
                  disabled={exportingCsv || filteredRuns.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-savi-teal/40 text-savi-teal hover:bg-savi-teal/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Download size={14} />
                  {t(lang, "historyExportCsv")}
                </button>
              </div>
            </div>
            {historyLoading ? (
              <div className="text-center py-8 text-gray-400">{t(lang, "loading")}</div>
            ) : filteredRuns.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <History size={40} className="mx-auto mb-3 opacity-30" />
                <p>{t(lang, "historyEmpty")}</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-4 py-3 font-semibold text-gray-600">{t(lang, "historyDate")}</th>
                      <th className="text-left px-4 py-3 font-semibold text-gray-600">{t(lang, "historyCampaign")}</th>
                      <th className="text-left px-4 py-3 font-semibold text-gray-600">{t(lang, "historySheet")}</th>
                      <th className="text-left px-4 py-3 font-semibold text-gray-600">{t(lang, "historyWeeklyFile")}</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-600">{t(lang, "historyAdded")}</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-600">{t(lang, "historySkipped")}</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-600">{t(lang, "historyRowCheck")}</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-600">{t(lang, "historyAmtCheck")}</th>
                      <th className="text-center px-4 py-3 font-semibold text-gray-600">{t(lang, "historyDownload")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredRuns.map((run: any) => (
                      <HistoryRow key={run.id} run={run} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* Master Files tab */}
          <TabsContent value="masterfiles">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-gray-900">{t(lang, "masterFilesTitle")}</h2>
              <p className="text-sm text-gray-500 mt-1">{t(lang, "masterFilesSubtitle")}</p>
            </div>
            {campaignsLoading ? (
              <div className="text-center py-8 text-gray-400">{t(lang, "loading")}</div>
            ) : campaigns.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <FolderOpen size={40} className="mx-auto mb-3 opacity-30" />
                <p>{t(lang, "masterFilesEmpty")}</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="text-left px-5 py-3 font-semibold text-gray-600">{t(lang, "campaignsTitle")}</th>
                      <th className="text-left px-5 py-3 font-semibold text-gray-600">{t(lang, "campaignClient")}</th>
                      <th className="text-left px-5 py-3 font-semibold text-gray-600">{t(lang, "masterFilesFileCol")}</th>
                      <th className="text-left px-5 py-3 font-semibold text-gray-600">{t(lang, "masterFilesLastUpdated")}</th>
                      <th className="text-center px-5 py-3 font-semibold text-gray-600">{t(lang, "masterFilesDownload")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {campaigns.map(c => (
                      <MasterFileRow key={c.id} campaign={c} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>

          {/* Campaigns tab */}
          <TabsContent value="campaigns">
            <div className="mb-6">
              <h2 className="text-xl font-bold text-gray-900">{t(lang, "campaignsTitle")}</h2>
              <p className="text-sm text-gray-500 mt-1">{t(lang, "campaignsSubtitle")}</p>
            </div>

            <UploadCampaignPanel onSuccess={() => refetchCampaigns()} />

            <div className="mt-6">
              {campaignsLoading ? (
                <div className="text-center py-8 text-gray-400">{t(lang, "loading")}</div>
              ) : campaigns.length === 0 ? (
                <div className="text-center py-12 text-gray-400">
                  <Building2 size={40} className="mx-auto mb-3 opacity-30" />
                  <p>{t(lang, "campaignNoData")}</p>
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {campaigns.map(c => (
                    <CampaignCard key={c.id} campaign={c} onRefresh={() => refetchCampaigns()} />
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
