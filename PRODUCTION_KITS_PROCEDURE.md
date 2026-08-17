# Production Kit Management Procedure

This document outlines the standard operating procedure for managing production kits within the Tracklab Inventory Management system. Production kits are used to track groups of components staged for specific assembly lines and projects.

## 1. Creating a New Production Kit

Users can create production kits either manually using the Wizard or by uploading a batch CSV file.

### 1.1 Manual Creation (Wizard)

1.  Navigate to the **Stock Tables** view via the sidebar.
2.  Click the **Provision New Kit** button in the top right corner.
3.  In the **Manual Wizard** tab, fill in the following details:
    *   **Production Kit Identifier (ID):** A unique identifier for the kit (e.g., `KIT-MGD-048`).
    *   **Target SKU Reference Match:** The main component or product SKU this kit is intended for.
    *   **Assembly Line Routing:** The designated assembly line for this kit (e.g., `Line 4 Delta`).
    *   **Initial Stock Quantities Ready:** The number of units currently staged in this kit.
    *   **Associate Project:** Select a project from the dropdown to link this kit to a specific project.
    *   **Deployment System Status:** Set the initial status (`STAGING`, `ACTIVE`, `READY`, or `BLOCKED`).
4.  Click **Instantiate Production Kit** to save the new kit to the database.

### 1.2 Batch CSV Upload

1.  In the **Provision New Kit** modal, switch to the **Batch CSV Upload** tab.
2.  Prepare a CSV file with the following headers:
    `kitId, skuReference, status, qtyAvailable, assemblyLine`
3.  Click the upload zone and select your `.csv` file.
4.  The system will parse the file and load the kits into the staging ledger.

## 2. Editing Existing Production Kits

To update the configuration or status of an existing kit:

1.  Navigate to the **Stock Tables** view.
2.  Ensure the **Production_Kits** table is selected.
3.  Locate the kit you wish to modify in the list.
4.  Click the **Edit** icon (pencil) in the **Actions** column for that row.
5.  The **Manual Wizard** will open, pre-populated with the kit's current details.
6.  Modify the fields as needed (e.g., update status from `STAGING` to `ACTIVE` or change the associated project).
7.  Click **Update Production Kit** to save your changes.

## 3. Project Association

Associating a kit with a project allows for better tracking of material allocation across different manufacturing runs.

1.  When creating or editing a kit, use the **Associate Project** dropdown.
2.  The dropdown contains all active projects registered in the system.
3.  Once associated, the project's human-readable name will be displayed in the **Associated Project** column of the Production Kits table.

## 4. Monitoring Kit Status

The status of a kit determines its role in the current manufacturing workflow:

*   **STAGING:** Kit is being prepared and is pending verification.
*   **ACTIVE:** Kit is currently being used on the assembly line.
*   **READY:** Kit is fully prepared and staged for allocation.
*   **BLOCKED:** Kit is on hold (e.g., due to missing parts or quality checks).

You can monitor these statuses and last updated timestamps directly from the **Stock Tables** dashboard.
