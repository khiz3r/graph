import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import TabContext from '@mui/lab/TabContext';
import TabList from '@mui/lab/TabList';
import TabPanel from '@mui/lab/TabPanel';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Unstable_Grid2';
import LinearProgress from '@mui/material/LinearProgress';
import { buildClientSchema } from 'graphql/utilities';
import { useCallback, useRef, useState } from 'react';

import { voyagerIntrospectionQuery } from '../utils/introspection-query';
import { sdlToSchema } from '../utils/sdl-to-introspection';

enum InputType {
  Presets = 'Presets',
  SDL = 'SDL',
  Introspection = 'Introspection',
}

interface IntrospectionModalProps {
  open: boolean;
  presets?: { [name: string]: any };
  onClose: () => void;
  onChange: (introspection: any) => void;
}

export function IntrospectionModal(props: IntrospectionModalProps) {
  const { open, presets, onChange, onClose } = props;
  const hasPresets = presets != null;
  const presetNames = hasPresets ? Object.keys(presets) : [];

  const [submitted, setSubmitted] = useState({
    inputType: hasPresets ? InputType.Presets : InputType.SDL,
    activePreset: presetNames.at(0) ?? '',
    sdlText: '',
    jsonText: '',
  });

  const [inputType, setInputType] = useState(submitted.inputType);
  const [sdlText, setSDLText] = useState(submitted.sdlText);
  const [jsonText, setJSONText] = useState(submitted.jsonText);
  const [activePreset, setActivePreset] = useState(submitted.activePreset);
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  // Holds the already-parsed data when loaded via file upload, avoiding re-parse on submit
  const parsedDataRef = useRef<any>(null);

  // Loads a file off the main thread using FileReader, then parses JSON in a
  // chunked setTimeout so the browser stays responsive on large (15MB+) files.
  const handleFileLoad = useCallback((file: File) => {
    setIsParsing(true);
    setParseError(null);
    parsedDataRef.current = null;

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      // Defer JSON.parse off the current microtask so the loading UI can paint first
      setTimeout(() => {
        try {
          const parsed = JSON.parse(text);
          parsedDataRef.current = parsed;
          // Show a truncated preview in the textarea so users see something loaded
          setJSONText(`[File loaded: ${file.name} — ${(file.size / 1_048_576).toFixed(1)} MB, ${Object.keys((parsed?.data?.__schema ?? parsed?.__schema ?? parsed)?.types ?? {}).length || '?'} types]`);
          setParseError(null);
        } catch (err) {
          setParseError('Invalid JSON: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
          setIsParsing(false);
        }
      }, 50);
    };
    reader.onerror = () => {
      setParseError('Failed to read file.');
      setIsParsing(false);
    };
    reader.readAsText(file);
  }, []);

  function handleCancel() {
    setInputType(submitted.inputType);
    setSDLText(submitted.sdlText);
    setJSONText(submitted.jsonText);
    setActivePreset(submitted.activePreset);
    parsedDataRef.current = null;
    setParseError(null);
    onClose();
  }

  function handleSubmit() {
    switch (inputType) {
      case InputType.Presets:
        onChange(buildClientSchema(presets?.[activePreset].data));
        break;
      case InputType.Introspection: {
        // If we already have pre-parsed data from a file upload, use it directly
        // to avoid re-parsing the full JSON string on the main thread.
        let data: any;
        if (parsedDataRef.current != null) {
          data = parsedDataRef.current;
        } else {
          try {
            data = JSON.parse(jsonText);
          } catch (err) {
            setParseError('Invalid JSON: ' + (err instanceof Error ? err.message : String(err)));
            return;
          }
        }
        // Support both { data: { __schema } } and bare { __schema } shapes
        const schemaData = data?.data ?? data;
        try {
          onChange(buildClientSchema(schemaData));
        } catch (err) {
          // "Decorated type deeper than introspection query" — schema has types
          // with more than 3 levels of list/non-null nesting. Strip them and retry.
          if (
            err instanceof Error &&
            err.message.includes('Decorated type deeper than introspection query')
          ) {
            try {
              const sanitized = sanitizeDeepTypes(schemaData);
              onChange(buildClientSchema(sanitized));
            } catch (err2) {
              setParseError(
                'Schema has unsupported deeply-nested types and could not be sanitized: ' +
                  (err2 instanceof Error ? err2.message : String(err2)),
              );
              return;
            }
          } else {
            setParseError(
              'Failed to build schema: ' +
                (err instanceof Error ? err.message : String(err)),
            );
            return;
          }
        }
        break;
      }
      case InputType.SDL:
        onChange(sdlToSchema(sdlText));
        break;
    }
    setSubmitted({ inputType, sdlText, jsonText, activePreset });
    parsedDataRef.current = null;
    onClose();
  }

  // Fixes two classes of broken ofType chains that cause buildClientSchema to crash:
  // 1. Truncated chains — the introspection query cut off before reaching a named
  //    type, leaving a LIST/NON_NULL node with no ofType key at all.
  // 2. Chains deeper than 7 levels — beyond what buildClientSchema supports.
  // Both are replaced with a plain String scalar so the rest of the schema loads.
  function sanitizeDeepTypes(schemaData: any): any {
    const MAX_DEPTH = 7;

    function fixType(t: any, depth: number = 0): any {
      if (!t) return null;

      // Truncated: LIST or NON_NULL with no ofType key — terminate the chain
      if ((t.kind === 'LIST' || t.kind === 'NON_NULL') && !('ofType' in t)) {
        return { kind: 'SCALAR', name: 'String', ofType: null };
      }

      // Too deep — replace entirely
      if (depth >= MAX_DEPTH) {
        return { kind: 'SCALAR', name: 'String', ofType: null };
      }

      return { ...t, ofType: fixType(t.ofType, depth + 1) };
    }

    function sanitizeField(field: any): any {
      return { ...field, type: fixType(field.type) };
    }

    const types = (schemaData.__schema?.types ?? []).map((type: any) => ({
      ...type,
      fields: type.fields?.map(sanitizeField) ?? type.fields,
      inputFields: type.inputFields?.map(sanitizeField) ?? type.inputFields,
    }));

    return {
      ...schemaData,
      __schema: { ...schemaData.__schema, types },
    };
  }

  return (
    <IntrospectionDialog
      open={open}
      onCancel={handleCancel}
      onSubmit={handleSubmit}
    >
      <TabContext value={inputType}>
        <TabList
          variant="fullWidth"
          indicatorColor="primary"
          textColor="primary"
          onChange={(_, activeTab) => setInputType(activeTab)}
        >
          {hasPresets && (
            <Tab value={InputType.Presets} label={InputType.Presets} />
          )}
          <Tab value={InputType.SDL} label={InputType.SDL} />
          <Tab
            value={InputType.Introspection}
            label={InputType.Introspection}
          />
        </TabList>
        {hasPresets && (
          <TabPanel value={InputType.Presets}>
            <PresetsTab
              presets={presets}
              activePreset={activePreset}
              onPresetChange={setActivePreset}
            />
          </TabPanel>
        )}
        <TabPanel value={InputType.SDL}>
          <SDLTab sdlText={sdlText} onSDLTextChange={setSDLText} />
        </TabPanel>
        <TabPanel value={InputType.Introspection}>
          <IntrospectionTab
            jsonText={jsonText}
            onJSONTextChange={(text) => {
              setJSONText(text);
              parsedDataRef.current = null;
              setParseError(null);
            }}
            isParsing={isParsing}
            parseError={parseError}
            onFileLoad={handleFileLoad}
          />
        </TabPanel>
      </TabContext>
    </IntrospectionDialog>
  );
}

interface IntrospectionDialogProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  children: JSX.Element;
}

function IntrospectionDialog(props: IntrospectionDialogProps) {
  const { open, onCancel, onSubmit, children } = props;
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      scroll="paper"
      PaperProps={{
        sx: {
          '&': {
            width: 0.9,
            height: 0.9,
            maxWidth: 800,
            maxHeight: 400,
          },
        },
      }}
    >
      <DialogContent style={{ paddingTop: 10, paddingBottom: 0 }}>
        {children}
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          style={{ background: '#eeeeee' }}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          style={{ color: 'white' }}
          onClick={onSubmit}
        >
          Display
        </Button>
      </DialogActions>
    </Dialog>
  );
}

interface PresetsTabProps {
  presets: { [name: string]: any };
  activePreset: string;
  onPresetChange: (presetName: string) => void;
}

function PresetsTab(props: PresetsTabProps) {
  const { presets, activePreset, onPresetChange } = props;
  const presetNames = Object.keys(presets);

  return (
    <Grid container spacing={4}>
      {presetNames.map((name) => (
        <Grid xs={12} sm={6} key={name}>
          <Button
            fullWidth
            color={activePreset === name ? 'primary' : 'secondary'}
            variant="outlined"
            onClick={() => onPresetChange(name)}
            sx={{
              height: { sm: 100 },
              boxShadow: '0px 0 8px 2px',
              textTransform: 'none',
            }}
          >
            <Typography component="span" variant="h5">
              {name}
            </Typography>
          </Button>
        </Grid>
      ))}
    </Grid>
  );
}

interface SDLTabProps {
  sdlText: string;
  onSDLTextChange: (sdl: string) => void;
}

function SDLTab(props: SDLTabProps) {
  const { sdlText, onSDLTextChange } = props;
  return (
    <Stack spacing={1} justifyContent="flex-start" alignItems="center">
      <TextField
        required
        multiline
        fullWidth
        rows={9}
        value={sdlText}
        placeholder="Paste SDL Here"
        onChange={(event) => onSDLTextChange(event.target.value)}
      />
      <PrivacyNote />
    </Stack>
  );
}

interface IntrospectionTabProps {
  jsonText: string;
  onJSONTextChange: (json: string) => void;
  isParsing: boolean;
  parseError: string | null;
  onFileLoad: (file: File) => void;
}

function IntrospectionTab(props: IntrospectionTabProps) {
  const { jsonText, onJSONTextChange, isParsing, parseError, onFileLoad } = props;
  const [isCopied, setIsCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isFilePlaceholder = jsonText.startsWith('[File loaded:');

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onFileLoad(file);
  }

  return (
    <Stack spacing={1} justifyContent="flex-start" alignItems="center">
      <Typography>
        Run the introspection query against a GraphQL endpoint. Paste the result
        below, or upload a <code>.json</code> file for large schemas (15MB+).
      </Typography>
      <Stack direction="row" spacing={1} width="100%" justifyContent="center">
        <Tooltip
          title="Copied!"
          open={isCopied}
          onClose={() => setIsCopied(false)}
          leaveDelay={1500}
        >
          <Button
            variant="outlined"
            startIcon={<ContentCopyIcon />}
            color="primary"
            size="small"
            // eslint-disable-next-line @typescript-eslint/no-misused-promises
            onClick={async () => {
              await navigator.clipboard.writeText(voyagerIntrospectionQuery);
              setIsCopied(true);
            }}
          >
            Copy Introspection Query
          </Button>
        </Tooltip>
        <Button
          variant="outlined"
          color="secondary"
          size="small"
          onClick={() => fileInputRef.current?.click()}
        >
          Upload JSON File
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFileLoad(file);
            e.target.value = '';
          }}
        />
      </Stack>

      {/* Drop zone + textarea */}
      <div
        style={{ width: '100%' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <TextField
          required
          multiline
          fullWidth
          rows={4}
          value={jsonText}
          placeholder="Paste introspection JSON here, or drag-and-drop / upload a .json file for large schemas"
          onChange={(event) => {
            if (!isFilePlaceholder) {
              onJSONTextChange(event.target.value);
            }
          }}
          InputProps={{
            readOnly: isFilePlaceholder,
            style: isFilePlaceholder ? { color: '#1976d2', fontStyle: 'italic' } : {},
          }}
          helperText={
            parseError
              ? parseError
              : isFilePlaceholder
              ? 'File loaded successfully. Click Display to visualize.'
              : 'For files larger than 5MB, use the Upload button instead of pasting.'
          }
          error={parseError != null}
        />
      </div>

      {isParsing && (
        <Stack spacing={0.5} width="100%" alignItems="center">
          <Typography variant="body2" color="text.secondary">
            Parsing schema…
          </Typography>
          <LinearProgress style={{ width: '100%' }} />
        </Stack>
      )}

      <PrivacyNote />
    </Stack>
  );
}

function PrivacyNote() {
  return (
    <Typography>
      <b>Privacy note: </b>
      Your schema is processed within browser and is not transmitted to external
      servers or third parties.
    </Typography>
  );
}
