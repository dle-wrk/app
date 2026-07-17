import React, { useState, useRef } from 'react';
// Import the absolute type definitions from your project source directory
import { ProductionKit, Project } from '../types';
import {
    Upload,
    Plus,
    FileSpreadsheet,
    Database,
    Layers,
    Wrench,
    X
} from 'lucide-react';

interface ProductionKitsManagerProps {
    onKitCreated: (newKit: ProductionKit) => void;
    onBatchKitsUploaded: (uploadedKits: ProductionKit[]) => void;
    triggerToast: (msg: string) => void;
    projects: Project[];
    editingKit?: ProductionKit | null;
    onCancelEdit?: () => void;
}

export default function ProductionKitsManager({
    onKitCreated,
    onBatchKitsUploaded,
    triggerToast,
    projects,
    editingKit,
    onCancelEdit
}: ProductionKitsManagerProps) {
    const [activeTab, setActiveTab] = useState<'create' | 'upload'>('create');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Form State aligned with 'ACTIVE' | 'READY' | 'STAGING' | 'BLOCKED'
    const [manualKit, setManualKit] = useState({
        kitId: editingKit?.kitId || '',
        skuReference: editingKit?.skuReference || '',
        status: (editingKit?.status || 'STAGING') as ProductionKit['status'],
        qtyAvailable: editingKit?.qtyAvailable || 0,
        assemblyLine: editingKit?.assemblyLine || '',
        projectId: editingKit?.projectId || undefined
    });

    React.useEffect(() => {
        if (editingKit) {
            setManualKit({
                kitId: editingKit.kitId,
                skuReference: editingKit.skuReference,
                status: editingKit.status,
                qtyAvailable: editingKit.qtyAvailable,
                assemblyLine: editingKit.assemblyLine,
                projectId: editingKit.projectId
            });
            setActiveTab('create');
        }
    }, [editingKit]);

    // Handle Manual Form Submission
    const handleManualSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!manualKit.kitId.trim() || !manualKit.skuReference.trim()) {
            triggerToast('Please populate all tracking identity specs.');
            return;
        }

        const builtKit: ProductionKit = {
            ...manualKit,
            kitId: manualKit.kitId.toUpperCase().trim(),
            skuReference: manualKit.skuReference.toUpperCase().trim(),
            lastUpdated: new Date().toISOString().split('T')[0]
        };

        onKitCreated(builtKit);
        triggerToast(`Production Kit ${builtKit.kitId} successfully ${editingKit ? 'updated' : 'compiled'}.`);

        // Reset Form
        setManualKit({
            kitId: '',
            skuReference: '',
            status: 'STAGING',
            qtyAvailable: 0,
            assemblyLine: '',
            projectId: undefined
        });
    };

    // Parse CSV Import Action Block
    const handleCSVUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const text = event.target?.result as string;
                const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

                if (lines.length <= 1) {
                    triggerToast('Uploaded document contains no batch structural rows.');
                    return;
                }

                const parsedKits: ProductionKit[] = [];
                const today = new Date().toISOString().split('T')[0];

                // Skip header processing rows
                for (let i = 1; i < lines.length; i++) {
                    const columns = lines[i].split(',').map(col => col.trim().replace(/^["']|["']$/g, ''));
                    if (columns.length < 5) continue;

                    // Map and validate status variation formats safely
                    let rawStatus = columns[2].toUpperCase();
                    let parsedStatus: ProductionKit['status'] = 'STAGING';
                    if (['ACTIVE', 'READY', 'STAGING', 'BLOCKED'].includes(rawStatus)) {
                        parsedStatus = rawStatus as ProductionKit['status'];
                    }

                    parsedKits.push({
                        kitId: columns[0].toUpperCase(),
                        skuReference: columns[1].toUpperCase(),
                        status: parsedStatus,
                        qtyAvailable: parseInt(columns[3], 10) || 0,
                        assemblyLine: columns[4],
                        lastUpdated: today
                    });
                }

                if (parsedKits.length === 0) {
                    triggerToast('Failed to parse valid dataset from CSV template format.');
                    return;
                }

                onBatchKitsUploaded(parsedKits);
                triggerToast(`Successfully loaded ${parsedKits.length} kits into staging ledger.`);
                if (fileInputRef.current) fileInputRef.current.value = '';
            } catch (err) {
                triggerToast('Error processing file binary tree map structures.');
            }
        };
        reader.readAsText(file);
    };

    return (
        <div className="bg-surface-container rounded-xl border border-outline-variant shadow-lg overflow-hidden text-on-surface animate-fade-in">

            {/* Top Controller Header Toggles */}
            <div className="border-b border-outline-variant bg-surface-container-high/40 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="p-2 bg-primary/10 text-primary rounded-lg border border-primary/20">
                        <Wrench className="w-5 h-5" />
                    </div>
                    <div>
                        <h3 className="text-sm font-bold tracking-tight">Production Kit Provisioning</h3>
                        <p className="text-[11px] text-on-surface-variant/80">Deploy individual hardware assembly specs or ingest multi-tier batch lists.</p>
                    </div>
                </div>

                {/* Tab Selection Switches */}
                <div className="flex bg-surface-container-low border border-outline-variant p-1 rounded-lg self-start sm:self-auto">
                    <button
                        type="button"
                        onClick={() => setActiveTab('create')}
                        className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${activeTab === 'create'
                                ? 'bg-primary text-on-primary shadow'
                                : 'text-on-surface-variant hover:text-on-surface'
                            }`}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Manual Wizard
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('upload')}
                        className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${activeTab === 'upload'
                                ? 'bg-primary text-on-primary shadow'
                                : 'text-on-surface-variant hover:text-on-surface'
                            }`}
                    >
                        <Upload className="w-3.5 h-3.5" />
                        Batch CSV Upload
                    </button>
                </div>
            </div>

            {/* Main Core View Router Section Container */}
            <div className="p-5">
                {activeTab === 'create' ? (

                    /* MANUAL CREATION FORM WIZARD */
                    <form onSubmit={handleManualSubmit} className="space-y-4 text-xs">
                        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">

                            {/* Kit ID Input */}
                            <div className="flex flex-col gap-1.5">
                                <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                                    Production Kit Identifier (ID)
                                </label>
                                <input
                                    type="text"
                                    placeholder="e.g. KIT-MGD-048"
                                    required
                                    className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 font-mono text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
                                    value={manualKit.kitId}
                                    onChange={(e) => setManualKit({ ...manualKit, kitId: e.target.value })}
                                />
                            </div>

                            {/* SKU Template Target */}
                            <div className="flex flex-col gap-1.5">
                                <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                                    Target SKU Reference Match
                                </label>
                                <input
                                    type="text"
                                    placeholder="e.g. TL-MCU-ESP32-V2"
                                    required
                                    className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 font-mono text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
                                    value={manualKit.skuReference}
                                    onChange={(e) => setManualKit({ ...manualKit, skuReference: e.target.value })}
                                />
                            </div>

                            {/* Assembly Line Designation */}
                            <div className="flex flex-col gap-1.5">
                                <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                                    Assembly Line Routing
                                </label>
                                <input
                                    type="text"
                                    placeholder="e.g. Line 4 Delta Matrix"
                                    required
                                    className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
                                    value={manualKit.assemblyLine}
                                    onChange={(e) => setManualKit({ ...manualKit, assemblyLine: e.target.value })}
                                />
                            </div>

                            {/* Staging Initial Quantities */}
                            <div className="flex flex-col gap-1.5">
                                <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                                    Initial Stock Quantities Ready
                                </label>
                                <input
                                    type="number"
                                    min="0"
                                    className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 font-mono text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all"
                                    value={manualKit.qtyAvailable || ''}
                                    onChange={(e) => setManualKit({ ...manualKit, qtyAvailable: parseInt(e.target.value, 10) || 0 })}
                                />
                            </div>

                            {/* Project Association Selection */}
                            <div className="flex flex-col gap-1.5">
                                <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                                    Associate Project
                                </label>
                                <select aria-label="Project Selection"
                                    className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all cursor-pointer"
                                    value={manualKit.projectId || ''}
                                    onChange={(e) => setManualKit({ ...manualKit, projectId: e.target.value ? parseInt(e.target.value, 10) : undefined })}
                                >
                                    <option value="" className="bg-surface-container-high">No Project Associated</option>
                                    {projects.map(p => (
                                        <option key={p.id} value={p.id} className="bg-surface-container-high">
                                            {p.projectName}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Initialization Status Class Selection */}
                            <div className="flex flex-col gap-1.5">
                                <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                                    Deployment System Status
                                </label>
                                <select aria-label="Selection"
                                    className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all cursor-pointer"
                                    value={manualKit.status}
                                    onChange={(e) => setManualKit({ ...manualKit, status: e.target.value as ProductionKit['status'] })}
                                >
                                    <option value="STAGING" className="bg-surface-container-high">STAGING (Pending Verification)</option>
                                    <option value="ACTIVE" className="bg-surface-container-high">ACTIVE (Running Operations)</option>
                                    <option value="READY" className="bg-surface-container-high">READY (Staged Allocation)</option>
                                    <option value="BLOCKED" className="bg-surface-container-high">BLOCKED (System Hold)</option>
                                </select>
                            </div>

                            {/* Submit CTA Trigger Block Container */}
                            <div className="flex items-end pt-2 sm:pt-0 gap-2">
                                {editingKit && onCancelEdit && (
                                    <button
                                        type="button"
                                        onClick={onCancelEdit}
                                        className="bg-surface-container-high text-on-surface font-bold px-4 py-2.5 rounded-lg border border-outline-variant flex items-center justify-center gap-2 hover:bg-surface-container-highest transition-all cursor-pointer"
                                    >
                                        <X className="w-4 h-4" />
                                        Cancel
                                    </button>
                                )}
                                <button
                                    type="submit"
                                    className="flex-1 bg-primary text-on-primary font-bold px-4 py-2.5 rounded-lg border border-primary/20 flex items-center justify-center gap-2 shadow hover:brightness-110 active:scale-[0.98] transition-all cursor-pointer"
                                >
                                    <Layers className="w-4 h-4" />
                                    {editingKit ? 'Update Production Kit' : 'Instantiate Production Kit'}
                                </button>
                            </div>

                        </div>
                    </form>
                ) : (

                    /* BATCH FILE UPLOAD DROPZONE DESIGN PANEL */
                    <div className="space-y-4">
                        <div
                            onClick={() => fileInputRef.current?.click()}
                            className="border-2 border-dashed border-outline-variant hover:border-primary/50 bg-surface-container-low/50 hover:bg-surface-container-high/20 rounded-xl p-8 flex flex-col items-center justify-center text-center gap-3 cursor-pointer transition-all duration-200"
                        >
                            <input
                                type="file"
                                ref={fileInputRef}
                                onChange={handleCSVUpload}
                                accept=".csv"
                                className="hidden"
                            />
                            <div className="p-3 bg-secondary/10 text-secondary border border-secondary/20 rounded-full">
                                <FileSpreadsheet className="w-6 h-6" />
                            </div>
                            <div>
                                <p className="text-xs font-bold text-on-surface">Click to map external template file context arrays</p>
                                <p className="text-[10px] text-on-surface-variant/60 mt-1">Accepts standard structured tabular comma-separated text sheets (*.csv)</p>
                            </div>
                        </div>

                        {/* CSV Structural Guideline Blueprint Banner */}
                        <div className="bg-surface-container-high/40 border border-outline-variant rounded-lg p-3.5 font-mono text-[10px] text-on-surface-variant/90 space-y-2">
                            <div className="flex items-center gap-2 text-primary font-bold uppercase tracking-wider text-[11px]">
                                <Database className="w-3.5 h-3.5" />
                                Required Tabular Target Columns Specification Blueprint
                            </div>
                            <p className="leading-relaxed">
                                The import configuration sheet file must match the following sequence heading headers mapped directly on Row 1:
                            </p>
                            <div className="bg-surface-container-low border border-outline-variant p-2 rounded text-on-surface select-all overflow-x-auto whitespace-nowrap">
                                kitId, skuReference, status, qtyAvailable, assemblyLine
                            </div>
                            <div className="pt-1 text-on-surface-variant/70 italic">
                                * Available choices for system status processing variables block: ACTIVE, READY, STAGING, BLOCKED.
                            </div>
                        </div>
                    </div>
                )}
            </div>

        </div>
    );
}