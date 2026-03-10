import { Panel } from '../../components/Panel';
import { Section } from '../../components/Section';
import {
  DEFAULT_VISIBLE_FIELDS,
  type ConfigValue,
  type RiskGateDraft,
  type RiskGateField,
  type RiskGateSchema,
  type RiskGateSectionKey,
  type SaveState
} from './shared';

export interface RiskConfigSettingsSectionModel {
  schema: RiskGateSchema | null;
  draft: RiskGateDraft | null;
  expandedSections: Record<RiskGateSectionKey, boolean>;
  saveState: SaveState;
  onToggleSectionExpansion: (sectionKey: RiskGateSectionKey) => void;
  onFieldChange: (sectionKey: RiskGateSectionKey, field: RiskGateField, value: ConfigValue) => void;
  onSave: (sectionKey: RiskGateSectionKey) => void;
}

export function RiskConfigSettingsSection(props: { section: RiskConfigSettingsSectionModel }) {
  const { schema, draft, expandedSections, saveState, onToggleSectionExpansion, onFieldChange, onSave } =
    props.section;
  const sections = schema?.sections ?? [];

  return (
    <Section title="Config Settings" subtitle="Edit policy and risk thresholds via the ops API.">
      {sections.length === 0 || !draft ? (
        <Panel title="Settings" body={<p>Config schema not available.</p>} />
      ) : (
        sections.map((section) => {
          const sectionExpanded = expandedSections[section.key];
          const visibleFields = sectionExpanded ? section.fields : section.fields.slice(0, DEFAULT_VISIBLE_FIELDS);
          return (
            <Panel
              key={section.key}
              title={section.label}
              body={
                <div style={{ display: 'grid', gap: 16 }}>
                  {section.description ? <p style={{ margin: 0 }}>{section.description}</p> : null}
                  <div className="risk-section-meta">
                    <span>
                      Showing {visibleFields.length} of {section.fields.length} fields
                    </span>
                    {section.fields.length > DEFAULT_VISIBLE_FIELDS ? (
                      <button type="button" className="link-button" onClick={() => onToggleSectionExpansion(section.key)}>
                        {sectionExpanded ? 'Show fewer fields' : `Show all ${section.fields.length} fields`}
                      </button>
                    ) : null}
                  </div>
                  <div style={{ display: 'grid', gap: 12 }}>
                    {visibleFields.map((field) => (
                      <RiskFieldRow
                        key={field.key}
                        sectionKey={section.key}
                        field={field}
                        value={draft[section.key]?.[field.key]}
                        onFieldChange={onFieldChange}
                      />
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => onSave(section.key)}
                      disabled={saveState[section.key]?.saving}
                    >
                      {saveState[section.key]?.saving ? 'Saving…' : 'Save changes'}
                    </button>
                    {saveState[section.key]?.error ? (
                      <span style={{ color: 'var(--alert)' }}>{saveState[section.key]?.error}</span>
                    ) : null}
                    {saveState[section.key]?.savedAt ? (
                      <span style={{ color: 'var(--ink-muted)', fontSize: '0.8rem' }}>
                        Saved {new Date(saveState[section.key].savedAt as number).toLocaleTimeString()}
                      </span>
                    ) : null}
                  </div>
                </div>
              }
            />
          );
        })
      )}
    </Section>
  );
}

function RiskFieldRow(props: {
  sectionKey: RiskGateSectionKey;
  field: RiskGateField;
  value: ConfigValue;
  onFieldChange: (sectionKey: RiskGateSectionKey, field: RiskGateField, value: ConfigValue) => void;
}) {
  const { sectionKey, field, value, onFieldChange } = props;
  const fieldId = `${sectionKey}-${field.key}`;
  const descId = field.description ? `${fieldId}-desc` : undefined;

  return (
    <div className="risk-field-row">
      <div className="risk-field-meta">
        <label className="label" htmlFor={fieldId}>
          {field.label}
        </label>
        {field.description ? (
          <p id={descId} className="risk-field-description">
            {field.description}
          </p>
        ) : null}
      </div>
      <div className="risk-field-control">
        {field.type === 'boolean' ? (
          <input
            type="checkbox"
            id={fieldId}
            name={fieldId}
            aria-describedby={descId}
            checked={Boolean(value)}
            onChange={(event) => onFieldChange(sectionKey, field, event.target.checked)}
          />
        ) : field.type === 'enum' ? (
          <select
            id={fieldId}
            name={fieldId}
            aria-describedby={descId}
            value={String(value ?? '')}
            onChange={(event) => onFieldChange(sectionKey, field, event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="number"
            id={fieldId}
            name={fieldId}
            aria-describedby={descId}
            autoComplete="off"
            inputMode="decimal"
            value={value === '' || value === undefined || value === null ? '' : Number(value)}
            min={field.min}
            max={field.max}
            step={field.step ?? (field.integer ? 1 : 0.01)}
            onChange={(event) => {
              const raw = event.target.value;
              const nextValue = raw === '' ? '' : Number(raw);
              onFieldChange(sectionKey, field, Number.isNaN(nextValue) ? value : nextValue);
            }}
          />
        )}
        {field.type === 'number' && field.unit ? (
          <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>{field.unit}</span>
        ) : null}
      </div>
    </div>
  );
}
