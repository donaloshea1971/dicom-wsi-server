---
name: Share Unshare Logic Review and Improvements
overview: Review and improve the sharing/unsharing logic to ensure consistent security enforcement, support for hierarchical sharing (cases), and code consolidation.
todos:
  - id: refactor-can-access-study
    content: Refactor can_access_study in auth.py to support new hierarchy (slide_shares, case_shares, samples)
    status: pending
  - id: implement-case-sharing
    content: Implement share_case and unshare_case in auth.py and expose via API in main.py
    status: pending
  - id: secure-endpoints
    content: Audit and secure all /studies/{study_id}/... endpoints in main.py using can_access_study
    status: pending
  - id: cleanup-legacy-code
    content: Cleanup legacy study_owners and study_shares references in auth.py
    status: pending
  - id: bulk-unshare
    content: Add bulk unsharing support for slides
    status: pending
---

### 1. Security & Authorization Fixes

The primary finding is that while sharing logic exists, it is not consistently enforced on resource-level endpoints.

-   **Update `can_access_study`**: Refactor [converter/auth.py](c:\Users\donal.oshea_deciphex\DICOM Server\converter\auth.py) to check access across the new hierarchy model:
    -   Check `slides.owner_id`
    -   Check `slide_shares`
    -   Check `case_shares` (slides within shared cases)
    -   Check `slides.is_sample`
-   **Enforce Authorization**: Update [converter/main.py](c:\Users\donal.oshea_deciphex\DICOM Server\converter\main.py) to use `can_access_study` in all study-related endpoints (annotations, metadata, tiles, etc.).

### 2. Implement Case-Level Sharing

The database schema already supports `case_shares`, but the API does not expose it.

-   **New Endpoints**: Add `POST /cases/{case_id}/share` and `DELETE /cases/{case_id}/share/{user_id}` to `main.py`.
-   **New Auth Logic**: Add `share_case` and `unshare_case` functions to `auth.py`.

### 3. Consolidation and Cleanup

-   **Deprecated Code Removal**: Remove or update functions in `auth.py` that still use the legacy `study_owners` and `study_shares` tables.
-   **Consistent Naming**: Standardize on "slide" terminology for the new model (e.g., rename `share_study` to `share_slide` internally).

### 4. UI/UX Enhancements

-   **Case Sharing**: Update the frontend to allow sharing entire cases.
-   **Share Source Visibility**: Indicate in the UI if a slide is shared directly or inherited via a case share.
-   **Bulk Unshare**: Implement a bulk unshare feature for slides.

### Proposed Architecture for Access Control

```mermaid
graph TD
    User["User Request"] --> Auth["Auth (require_user)"]
    Auth --> Resource["Resource Endpoint (/studies/{id}/...)"]
    Resource --> AccessCheck["can_access_study(user_id, study_id)"]
    
    subgraph "Access Check Logic"
        AccessCheck --> IsOwner{"Is Owner?"}
        AccessCheck --> IsShared{"Directly Shared?"}
        AccessCheck --> IsCaseShared{"Case Shared?"}
        AccessCheck --> IsSample{"Is Public Sample?"}
    end
    
    IsOwner -->|Yes| Allow[Allow Access]
    IsShared -->|Yes| Allow
    IsCaseShared -->|Yes| Allow
    IsSample -->|Yes| Allow
    
    IsOwner -->|No| Denial[Deny Access]
    IsShared -->|No| Denial
    IsCaseShared -->|No| Denial
    IsSample -->|No| Denial
```