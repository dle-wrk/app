import React, { useState, useEffect } from 'react';
import { Plus, Folder, X, Link as LinkIcon, Trash2, Edit, Search, Calendar, Users, FileText, CheckCircle2, AlertTriangle, Activity } from 'lucide-react';
import { Item, Project, JobCard } from '../../types';

interface ProjectsViewProps {
  projects: Project[];
  items: Item[];
  projectReadiness: Record<number, any>;
  projectPlacementStats?: Record<number, number>;
  jobCards?: JobCard[];
  triggerToast: (msg: string) => void;
  onProjectCreated: (project: Project) => void;
  onProjectDeleted: (projectId: number) => void;
  onProjectUpdated: (project: Project) => void;
}

interface LinkedComponent {
  stockCode: string;
  quantity: number;
  designator: string;
  comment?: string;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  projects,
  items,
  projectReadiness,
  projectPlacementStats = {},
  jobCards = [],
  triggerToast,
  onProjectCreated,
  onProjectDeleted,
  onProjectUpdated
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  const [newProject, setNewProject] = useState({
    projectName: '',
    description: '',
    status: 'Active',
    startDate: '',
    endDate: '',
    assignedTeam: '',
    designSpecs: ''
  });

  const [selectedComponents, setSelectedComponents] = useState<Record<string, LinkedComponent>>({});

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProject.projectName.trim()) return;

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProject)
      });
      const data = await res.json();
      if (!res.ok) {
        triggerToast(data.error || 'Failed to create project');
        return;
      }
      
      onProjectCreated(data);
      triggerToast(`Project "${data.projectName}" created successfully`);
      setShowCreateModal(false);
      setNewProject({
        projectName: '',
        description: '',
        status: 'Active',
        startDate: '',
        endDate: '',
        assignedTeam: '',
        designSpecs: ''
      });
    } catch (err: any) {
      triggerToast(err.message || 'Failed to create project');
    }
  };

  const handleUpdateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject) return;

    try {
      const res = await fetch(`/api/projects/${editingProject.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingProject)
      });
      if (!res.ok) throw new Error('Failed to update project');
      onProjectUpdated(editingProject);
      triggerToast(`Project "${editingProject.projectName}" updated successfully`);
      setEditingProject(null);
    } catch (err) {
      triggerToast('Failed to update project');
    }
  };

  const handleDeleteProject = async (projectId: number) => {
    if (!confirm('Are you sure you want to delete this project? All associated BOM and P&P data will be removed.')) return;
    
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete project');
      onProjectDeleted(projectId);
      triggerToast('Project deleted successfully');
    } catch (err) {
      triggerToast('Failed to delete project');
    }
  };

  const handleLinkComponents = async () => {
    console.log('FRONTEND: handleLinkComponents CALLED');
    if (!selectedProject) {
      console.log('FRONTEND: selectedProject is null!');
      return;
    }
    
    const componentsArray = Object.entries(selectedComponents).map(([stockCode, data]) => ({
      stockCode,
      quantity: data.quantity,
      designator: data.designator,
      comment: data.comment || '',
      description: items.find(i => i.partNumber === stockCode)?.description || '',
      footprint: items.find(i => i.partNumber === stockCode)?.footprint || '',
      libref: ''
    }));
    console.log('FRONTEND: componentsArray mapped:', componentsArray.length);
    
    try {
      // Update inventory items with project reference
      for (const [stockCode] of Object.entries(selectedComponents)) {
        console.log('FRONTEND: PATCHing item project reference:', stockCode);
        await fetch(`/api/items/${encodeURIComponent(stockCode)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: selectedProject.projectName })
        });
        console.log('FRONTEND: PATCHed item project reference successfully:', stockCode);
      }
      
      // Create BOM entries
      console.log('FRONTEND: POSTing project BOM entries... url:', `/api/projects/${selectedProject.id}/bom`, 'body:', JSON.stringify({ items: componentsArray }));
      const bomRes = await fetch(`/api/projects/${selectedProject.id}/bom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: componentsArray })
      });
      console.log('FRONTEND: POSTed project BOM entries successfully. status:', bomRes.status);
      
      // Create P&P entries
      console.log('FRONTEND: POSTing project PP entries...');
      const ppRes = await fetch(`/api/projects/${selectedProject.id}/pp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: componentsArray })
      });
      console.log('FRONTEND: POSTed project PP entries successfully. status:', ppRes.status);
      
      // Create initial job card
      console.log('FRONTEND: POSTing initial job card...');
      const jcRes = await fetch('/api/job-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProject.id,
          buildQty: 0,
          status: 'Pending'
        })
      });
      console.log('FRONTEND: POSTed initial job card successfully. status:', jcRes.status);
      
      triggerToast(`${Object.keys(selectedComponents).length} components linked to project "${selectedProject.projectName}"`);
      setSelectedComponents({});
      setShowLinkModal(false);
    } catch (err: any) {
      console.error('FRONTEND ERROR in handleLinkComponents:', err);
      triggerToast('Failed to link components');
    }
  };

  const handleOpenLinkModal = async (project: Project) => {
    console.log('handleOpenLinkModal CALLED for project:', project.projectName, 'id:', project.id);
    setSelectedProject(project);
    setSearchQuery('');
    
    // Fetch existing BOM items for this project and include inventory items with project assigned
    try {
      const res = await fetch(`/api/projects/${project.id}/bom`);
      console.log('Fetch response status:', res.status);
      if (res.ok) {
        const existingItems = await res.json();
        console.log('BOM existing items fetched:', existingItems.length);
        const existingComponents: Record<string, LinkedComponent> = {};
        existingItems.forEach((item: any) => {
          existingComponents[item.stockCode] = {
            stockCode: item.stockCode,
            quantity: item.quantity,
            designator: item.designator,
            comment: item.comment || ''
          };
        });
        // Also include inventory items that already have this project name assigned
        items.forEach((invItem) => {
          if (invItem.project === project.projectName && !existingComponents[invItem.partNumber]) {
            existingComponents[invItem.partNumber] = {
              stockCode: invItem.partNumber,
              quantity: 1,
              designator: '',
              comment: ''
            };
          }
        });
        console.log('Final existingComponents:', Object.keys(existingComponents).length);
        setSelectedComponents(existingComponents);
      } else {
        console.log('Fetch response is NOT ok, checking inventory fallback');
        // Even if no BOM exists, check inventory for items with this project
        const inventoryComponents: Record<string, LinkedComponent> = {};
        items.forEach((invItem) => {
          if (invItem.project === project.projectName) {
            inventoryComponents[invItem.partNumber] = {
              stockCode: invItem.partNumber,
              quantity: 1,
              designator: ''
            };
          }
        });
        console.log('Fallback inventoryComponents:', Object.keys(inventoryComponents).length);
        setSelectedComponents(inventoryComponents);
      }
    } catch (err: any) {
      console.error('ERROR in handleOpenLinkModal fetch:', err);
      setSelectedComponents({});
    }
    
    console.log('Setting showLinkModal to true');
    setShowLinkModal(true);
  };

  return (
    <div className="p-container-margin space-y-lg max-w-7xl mx-auto w-full">
      <div className="flex justify-between items-end mb-lg">
        <div>
          <h3 className="font-headline-sm text-lg text-on-surface">Project Manager</h3>
          <p className="text-on-surface-variant font-body-sm">
            Create new projects and link components for BOM and Pick & Place operations.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-primary text-on-primary text-xs font-bold px-md py-2 rounded flex items-center gap-1 shadow cursor-pointer"
        >
          <Plus className="w-4 h-4" /> New Project
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md">
        {projects.map(project => {
          const readiness = projectReadiness[project.id];
          const hasShortages = readiness && readiness.some((r: any) => r.shortage_qty > 0);
          const isReady = readiness && readiness.length > 0 && !hasShortages;

          // Enhanced progress calculation based on dates AND job cards
          let dateProgress = 0;
          if (project.startDate && project.endDate) {
            const start = new Date(project.startDate).getTime();
            const end = new Date(project.endDate).getTime();
            const now = new Date().getTime();
            if (now > start && end > start) {
              dateProgress = Math.min(100, Math.round(((now - start) / (end - start)) * 100));
            } else if (now >= end) {
              dateProgress = 100;
            }
          }

          const projectJobs = jobCards.filter(j => j.projectId === project.id);
          const completedJobs = projectJobs.filter(j => j.status === 'Completed').length;
          const jobProgress = projectJobs.length > 0 ? Math.round((completedJobs / projectJobs.length) * 100) : 0;

          // Weighted progress: 40% timeline, 60% execution
          const totalProgress = projectJobs.length > 0
            ? Math.round((dateProgress * 0.4) + (jobProgress * 0.6))
            : dateProgress;

          return (
          <div key={project.id} className="bg-surface-container border border-outline-variant rounded-xl p-lg hover:border-primary/50 transition-all flex flex-col">
            <div className="flex justify-between items-start mb-sm">
              <div className="flex items-center gap-xs">
                <Folder className="w-4 h-4 text-primary" />
                <span className="font-bold text-sm text-on-surface">{project.projectName}</span>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${project.status === 'Active' ? 'bg-green-500/10 text-green-400' : 'bg-surface-container-highest text-outline'}`}>
                  {project.status}
                </span>
                {readiness && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold flex items-center gap-1 ${isReady ? 'bg-blue-500/10 text-blue-400' : hasShortages ? 'bg-red-500/10 text-red-400' : 'bg-surface-container-high text-outline'}`}>
                    {isReady ? <CheckCircle2 className="w-2.5 h-2.5" /> : hasShortages ? <AlertTriangle className="w-2.5 h-2.5" /> : null}
                    {isReady ? 'READY' : hasShortages ? 'SHORTAGES' : 'NO BOM'}
                  </span>
                )}
                {projectPlacementStats[project.id] !== undefined && (
                  <span className="text-[8px] font-mono text-outline-variant bg-surface-container-high px-1 rounded border border-outline-variant/30">
                    CAD: {projectPlacementStats[project.id]} pts
                  </span>
                )}
              </div>
            </div>
            
            <p className="text-xs text-on-surface-variant mb-md line-clamp-2 h-8">{project.description || 'No description'}</p>

            <div className="space-y-3 mb-md flex-1">
              {/* Timeline Progress */}
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] font-mono text-outline">
                  <span className="flex items-center gap-1">
                    <Activity className="w-3 h-3 text-primary" />
                    Unified Progress
                  </span>
                  <span>{totalProgress}%</span>
                </div>
                <div className="w-full bg-surface-container-high h-1.5 rounded-full overflow-hidden border border-outline-variant/30">
                  <div
                    className="bg-primary h-full transition-all duration-500"
                    style={{ width: `${totalProgress}%` }}
                  />
                </div>
                <div className="flex justify-between text-[9px] text-outline-variant">
                  <span className="flex items-center gap-1"><Calendar className="w-2.5 h-2.5" /> {project.startDate || 'TBD'}</span>
                  <span className="flex items-center gap-1">{project.endDate || 'TBD'} <Calendar className="w-2.5 h-2.5" /></span>
                </div>
              </div>

              {/* Job Cards Link */}
              {projectJobs.length > 0 && (
                <div className="flex items-center gap-2 bg-secondary/5 border border-secondary/20 p-1.5 rounded text-[9px] font-mono">
                  <Activity className="w-3 h-3 text-secondary" />
                  <span className="text-on-surface truncate">
                    {projectJobs.length} Job Cards ({completedJobs} Done)
                  </span>
                </div>
              )}

              {/* Resource & Specs Summary */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-surface-container-high/40 p-2 rounded border border-outline-variant/30">
                  <span className="text-[9px] text-outline uppercase block mb-1 items-center gap-1">
                    <Users className="w-2.5 h-2.5" /> Team
                  </span>
                  <span className="text-[10px] font-bold text-on-surface truncate block">
                    {project.assignedTeam || 'Unassigned'}
                  </span>
                </div>
                <div className="bg-surface-container-high/40 p-2 rounded border border-outline-variant/30">
                  <span className="text-[9px] text-outline uppercase mb-1 flex items-center gap-1">
                    <FileText className="w-2.5 h-2.5" /> Specs
                  </span>
                  <span className="text-[10px] font-bold text-on-surface truncate block">
                    {project.designSpecs ? 'Defined' : 'Empty'}
                  </span>
                </div>
              </div>
            </div>

            <div className="text-[9px] text-outline mb-3 font-mono">
              Created: {project.createdDate}
            </div>

            <div className="flex gap-sm mt-auto">
              <button
                onClick={() => handleOpenLinkModal(project)}
                className="flex-1 bg-surface-container-high hover:bg-surface-container-highest text-primary text-xs font-bold py-1.5 rounded flex items-center justify-center gap-1 cursor-pointer"
              >
                <LinkIcon className="w-3 h-3" /> Link Components
              </button>
              <button
                onClick={() => setEditingProject(project)}
                className="bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant p-1.5 rounded cursor-pointer"
              >
                <Edit className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleDeleteProject(project.id)}
                className="bg-surface-container-high hover:bg-red-500/10 text-red-400 p-1.5 rounded cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )})}
      </div>

      {/* Create Project Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
          <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[448px] w-full p-lg shadow-2xl relative">
            <button onClick={() => setShowCreateModal(false)} className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface p-1.5 rounded-lg transition-colors">
              <X className="w-4 h-4" />
            </button>
            <h4 className="font-headline-sm text-lg font-black text-primary mb-md">Create New Project</h4>
            <form onSubmit={handleCreateProject} className="space-y-sm text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1 col-span-2">
                  <label htmlFor="projectName" className="font-bold text-outline">Project Name</label>
                  <input
                    id="projectName"
                    required
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs"
                    value={newProject.projectName}
                    onChange={e => setNewProject({ ...newProject, projectName: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1 col-span-2">
                  <label htmlFor="description" className="font-bold text-outline">Description</label>
                  <textarea
                    id="description"
                    rows={2}
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={newProject.description}
                    onChange={e => setNewProject({ ...newProject, description: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="startDate" className="font-bold text-outline">Start Date</label>
                  <input
                    id="startDate"
                    type="date"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={newProject.startDate}
                    onChange={e => setNewProject({ ...newProject, startDate: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="endDate" className="font-bold text-outline">End Date</label>
                  <input
                    id="endDate"
                    type="date"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={newProject.endDate}
                    onChange={e => setNewProject({ ...newProject, endDate: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="assignedTeam" className="font-bold text-outline">Assigned Team</label>
                  <input
                    id="assignedTeam"
                    placeholder="e.g. Engineering A"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={newProject.assignedTeam}
                    onChange={e => setNewProject({ ...newProject, assignedTeam: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="status" className="font-bold text-outline">Initial Status</label>
                  <select
                    id="status"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none text-xs"
                    value={newProject.status}
                    onChange={e => setNewProject({ ...newProject, status: e.target.value })}
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1 col-span-2">
                  <label htmlFor="designSpecs" className="font-bold text-outline">Design Specifications</label>
                  <textarea
                    id="designSpecs"
                    rows={3}
                    placeholder="Enter key technical requirements..."
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={newProject.designSpecs}
                    onChange={e => setNewProject({ ...newProject, designSpecs: e.target.value })}
                  />
                </div>
              </div>
              <button type="submit" className="w-full bg-primary text-on-primary py-2.5 rounded font-bold text-xs uppercase tracking-wider mt-sm">
                Create Project
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Edit Project Modal */}
      {editingProject && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
          <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[448px] w-full p-lg shadow-2xl relative">
            <button onClick={() => setEditingProject(null)} className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface p-1.5 rounded-lg transition-colors">
              <X className="w-4 h-4" />
            </button>
            <h4 className="font-headline-sm text-lg font-black text-primary mb-md">Edit Project</h4>
            <form onSubmit={handleUpdateProject} className="space-y-sm text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="font-bold text-outline">Project Name</label>
                  <input
                    required
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary font-mono text-xs"
                    value={editingProject.projectName}
                    onChange={e => setEditingProject({ ...editingProject, projectName: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="font-bold text-outline">Description</label>
                  <textarea
                    rows={2}
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={editingProject.description}
                    onChange={e => setEditingProject({ ...editingProject, description: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Start Date</label>
                  <input
                    type="date"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={editingProject.startDate || ''}
                    onChange={e => setEditingProject({ ...editingProject, startDate: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">End Date</label>
                  <input
                    type="date"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={editingProject.endDate || ''}
                    onChange={e => setEditingProject({ ...editingProject, endDate: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Assigned Team</label>
                  <input
                    placeholder="e.g. Engineering A"
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={editingProject.assignedTeam || ''}
                    onChange={e => setEditingProject({ ...editingProject, assignedTeam: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="font-bold text-outline">Status</label>
                  <select
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none text-xs"
                    value={editingProject.status}
                    onChange={e => setEditingProject({ ...editingProject, status: e.target.value })}
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                    <option value="Completed">Completed</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1 col-span-2">
                  <label className="font-bold text-outline">Design Specifications</label>
                  <textarea
                    rows={3}
                    placeholder="Enter key technical requirements..."
                    className="bg-surface-container-high border border-outline-variant rounded p-2 text-on-surface outline-none focus:border-primary text-xs"
                    value={editingProject.designSpecs || ''}
                    onChange={e => setEditingProject({ ...editingProject, designSpecs: e.target.value })}
                  />
                </div>
              </div>
              <button type="submit" className="w-full bg-primary text-on-primary py-2.5 rounded font-bold text-xs uppercase tracking-wider mt-sm">
                Update Project
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Link Components Modal */}
      {showLinkModal && selectedProject && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-100 p-md">
          <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[1000px] w-full p-lg shadow-2xl relative max-h-[85vh] flex flex-col">
            <button onClick={() => setShowLinkModal(false)} className="absolute top-sm right-sm text-on-surface-variant hover:text-on-surface p-1.5 rounded-lg transition-colors z-10">
              <X className="w-4 h-4" />
            </button>
            <h4 className="font-headline-sm text-lg font-black text-primary mb-xs">BOM Manager</h4>
            <p className="text-xs text-on-surface-variant mb-md">Manage and synchronize Bill of Materials (BOM) components for {selectedProject.projectName}.</p>
            
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-lg overflow-hidden min-h-0 mb-md">

              {/* Left Column: Inventory Search / Add */}
              <div className="flex flex-col h-full overflow-hidden border-r border-outline-variant/30 pr-md">
                <label className="text-xs font-bold text-outline mb-sm">Add Components</label>
                <div className="relative mb-sm">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-outline" />
                  <input
                    type="text"
                    placeholder="Search stock code or name..."
                    className="w-full bg-surface-container-high border border-outline-variant rounded pl-8 pr-2 py-1.5 text-xs font-mono outline-none focus:border-primary"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                  />
                </div>

                <div className="flex-1 overflow-y-auto space-y-1 pr-1">
                  {items
                    .filter(item =>
                      searchQuery === '' ||
                      item.partNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      item.name.toLowerCase().includes(searchQuery.toLowerCase())
                    )
                    .map(item => {
                      const isSelected = selectedComponents[item.partNumber] !== undefined;
                      return (
                        <div
                          key={item.partNumber}
                          onClick={() => {
                            if (!isSelected) {
                              setSelectedComponents({
                                ...selectedComponents,
                                [item.partNumber]: { stockCode: item.partNumber, quantity: 1, designator: '', comment: '' }
                              });
                            }
                          }}
                          className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                            isSelected
                              ? 'bg-primary/10 text-primary border border-primary/20'
                              : 'hover:bg-surface-container-high border border-transparent'
                          }`}
                        >
                          <div className="flex flex-col">
                            <span className="font-mono text-xs font-bold">{item.partNumber}</span>
                            <span className="text-[10px] text-on-surface-variant truncate max-w-[200px]">{item.name}</span>
                          </div>
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-surface-container-high text-outline">
                            {isSelected ? 'Added' : 'Click to Add'}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* Right Column: Current BOM Items */}
              <div className="flex flex-col h-full overflow-hidden pl-md">
                <label className="text-xs font-bold text-outline mb-sm">Current BOM Items ({Object.keys(selectedComponents).length})</label>
                <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                  {Object.keys(selectedComponents).length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-outline-variant italic text-xs">
                      No components linked. Add from the left catalog.
                    </div>
                  ) : (
                    Object.entries(selectedComponents).map(([stockCode, currentData]) => {
                      const itemDetails = items.find(i => i.partNumber === stockCode);
                      return (
                        <div key={stockCode} className="bg-surface-container-high/50 border border-outline-variant/40 rounded-lg p-3 space-y-2 relative">
                          <button
                            type="button"
                            onClick={() => {
                              const newComponents = { ...selectedComponents };
                              delete newComponents[stockCode];
                              setSelectedComponents(newComponents);
                            }}
                            className="absolute top-2 right-2 text-red-400 hover:text-red-500 hover:bg-red-500/10 p-1 rounded-md transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>

                          <div className="flex flex-col">
                            <span className="font-mono text-xs font-bold text-primary">{stockCode}</span>
                            <span className="text-[10px] text-on-surface-variant truncate max-w-[250px]">{itemDetails?.name || 'Unknown Item'}</span>
                          </div>

                          <div className="grid grid-cols-12 gap-2 text-xs">
                            <div className="col-span-4 flex flex-col gap-1">
                              <label className="text-[10px] text-outline font-bold">Qty</label>
                              <input
                                type="number"
                                min="1"
                                className="w-full bg-surface-container border border-outline-variant rounded px-2 py-1 text-xs font-mono text-on-surface outline-none focus:border-primary"
                                value={currentData.quantity}
                                onChange={e => setSelectedComponents({
                                  ...selectedComponents,
                                  [stockCode]: { ...currentData, quantity: parseInt(e.target.value) || 1 }
                                })}
                              />
                            </div>
                            <div className="col-span-8 flex flex-col gap-1">
                              <label className="text-[10px] text-outline font-bold">Designator</label>
                              <input
                                type="text"
                                placeholder="e.g. C1, C2, R15"
                                className="w-full bg-surface-container border border-outline-variant rounded px-2 py-1 text-xs font-mono text-on-surface outline-none focus:border-primary"
                                value={currentData.designator}
                                onChange={e => setSelectedComponents({
                                  ...selectedComponents,
                                  [stockCode]: { ...currentData, designator: e.target.value }
                                })}
                              />
                            </div>
                            <div className="col-span-12 flex flex-col gap-1">
                              <label className="text-[10px] text-outline font-bold">Comment</label>
                              <input
                                type="text"
                                placeholder="Additional notes for this line item..."
                                className="w-full bg-surface-container border border-outline-variant rounded px-2 py-1 text-xs font-mono text-on-surface outline-none focus:border-primary"
                                value={currentData.comment || ''}
                                onChange={e => setSelectedComponents({
                                  ...selectedComponents,
                                  [stockCode]: { ...currentData, comment: e.target.value }
                                })}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

            </div>

            <div className="flex gap-sm">
              <button
                onClick={() => setShowLinkModal(false)}
                className="flex-1 border border-outline-variant hover:bg-surface-container-high text-on-surface py-2.5 rounded text-xs font-bold cursor-pointer"
              >
                Cancel
              </button>
              <button
                id="sync-btn-raw"
                onClick={() => {
                  console.log('FRONTEND: SYNC BUTTON DOM CLICKED');
                  handleLinkComponents();
                }}
                className="flex-1 bg-primary text-on-primary py-2.5 rounded text-xs font-bold uppercase tracking-wider cursor-pointer"
              >
                Sync
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};