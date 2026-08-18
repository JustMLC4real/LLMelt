import React, { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface ConfirmDialogProps {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app bevestigingsdialoog in de stijl van de rest van de app (i.p.v. de
 * native Windows-melding). De Annuleer-knop krijgt focus, dus Enter annuleert
 * en Escape sluit — je wist nooit per ongeluk iets.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  detail,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const resolvedConfirmLabel = confirmLabel ?? t('confirm.delete');
  const resolvedCancelLabel = cancelLabel ?? t('confirm.cancel');

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="model-selector-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog motion-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-head">
          <span className={`confirm-dialog-icon ${danger ? 'danger' : ''}`}>
            <AlertTriangle size={18} />
          </span>
          <div className="confirm-dialog-text">
            <div className="confirm-dialog-title" id="confirm-dialog-title">{title}</div>
            <div className="confirm-dialog-message">{message}</div>
          </div>
        </div>

        {detail && <div className="confirm-dialog-detail">{detail}</div>}

        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel}>
            {resolvedCancelLabel}
          </button>
          <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
