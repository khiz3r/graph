import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Component } from 'react';

import { renderSvg, TypeGraph, Viewport } from './../graph/';
import LoadingAnimation from './utils/LoadingAnimation';
import { VoyagerDisplayOptions } from './Voyager';

interface GraphViewportProps {
  typeGraph: TypeGraph | null;
  displayOptions: VoyagerDisplayOptions;

  selectedTypeID: string | null;
  selectedEdgeID: string | null;

  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string) => void;
}

// Schemas with more nodes than this will show a warning instead of rendering
// immediately — Graphviz layout of very large graphs can take 30–60 s and
// will appear to hang the browser tab.
const LARGE_SCHEMA_NODE_THRESHOLD = 400;

interface GraphViewportState {
  typeGraph: TypeGraph | null;
  displayOptions: VoyagerDisplayOptions | null;
  svgViewport: Viewport | null;
  // True once the user explicitly clicks "Render anyway" for a large schema
  forceRender: boolean;
}

export default class GraphViewport extends Component<
  GraphViewportProps,
  GraphViewportState
> {
  state: GraphViewportState = {
    typeGraph: null,
    displayOptions: null,
    svgViewport: null,
    forceRender: false,
  };

  // Handle async graph rendering based on this example
  // https://gist.github.com/bvaughn/982ab689a41097237f6e9860db7ca8d6
  _currentTypeGraph: TypeGraph | null = null;
  _currentDisplayOptions: VoyagerDisplayOptions | null = null;

  static getDerivedStateFromProps(
    props: GraphViewportProps,
    state: GraphViewportState,
  ): GraphViewportState | null {
    const { typeGraph, displayOptions } = props;

    if (
      typeGraph !== state.typeGraph ||
      displayOptions !== state.displayOptions
    ) {
      return { typeGraph, displayOptions, svgViewport: null, forceRender: false };
    }

    return null;
  }

  componentDidMount() {
    const { typeGraph, displayOptions } = this.props;
    this._renderSvgAsync(typeGraph, displayOptions);
  }

  componentDidUpdate(
    prevProps: GraphViewportProps,
    prevState: GraphViewportState,
  ) {
    const { svgViewport } = this.state;

    if (svgViewport == null) {
      const { typeGraph, displayOptions } = this.props;
      this._renderSvgAsync(typeGraph, displayOptions);
      return;
    }

    const isJustRendered = prevState.svgViewport == null;
    const { selectedTypeID, selectedEdgeID } = this.props;

    if (prevProps.selectedTypeID !== selectedTypeID || isJustRendered) {
      svgViewport.selectNodeById(selectedTypeID);
    }

    if (prevProps.selectedEdgeID !== selectedEdgeID || isJustRendered) {
      svgViewport.selectEdgeById(selectedEdgeID);
    }
  }

  componentWillUnmount() {
    this._currentTypeGraph = null;
    this._currentDisplayOptions = null;
    this._cleanupSvgViewport();
  }

  _renderSvgAsync(
    typeGraph: TypeGraph | null,
    displayOptions: VoyagerDisplayOptions | null,
  ) {
    if (typeGraph == null || displayOptions == null) {
      return; // Nothing to render
    }

    // For large schemas, wait until the user explicitly opts in to avoid
    // freezing the Graphviz worker for 30-60 s on the initial load.
    if (
      typeGraph.nodes.size > LARGE_SCHEMA_NODE_THRESHOLD &&
      !this.state.forceRender
    ) {
      return;
    }

    if (
      typeGraph === this._currentTypeGraph &&
      displayOptions === this._currentDisplayOptions
    ) {
      return; // Already rendering in background
    }

    this._currentTypeGraph = typeGraph;
    this._currentDisplayOptions = displayOptions;

    const { onSelectNode, onSelectEdge } = this.props;
    renderSvg(typeGraph, displayOptions)
      .then((svg) => {
        if (
          typeGraph !== this._currentTypeGraph ||
          displayOptions !== this._currentDisplayOptions
        ) {
          return; // One of the past rendering jobs finished
        }

        this._cleanupSvgViewport();
        const containerRef = this.refs['viewport'] as HTMLElement;
        const svgViewport = new Viewport(
          svg,
          containerRef,
          onSelectNode,
          onSelectEdge,
        );
        this.setState({ svgViewport });
      })
      .catch((rawError) => {
        this._currentTypeGraph = null;
        this._currentDisplayOptions = null;

        const error =
          rawError instanceof Error
            ? rawError
            : new Error('Unknown error: ' + String(rawError));
        this.setState(() => {
          throw error;
        });
      });
  }

  render() {
    const { typeGraph } = this.props;
    const { svgViewport, forceRender } = this.state;
    const isLoading = svgViewport == null;
    const nodeCount = typeGraph?.nodes.size ?? 0;
    const isLarge = nodeCount > LARGE_SCHEMA_NODE_THRESHOLD && !forceRender;

    if (isLarge) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 16,
            padding: 32,
            textAlign: 'center',
          }}
        >
          <Typography variant="h6">Large schema detected</Typography>
          <Typography variant="body1" color="text.secondary">
            This schema has <strong>{nodeCount} types</strong>. Rendering it
            all at once with Graphviz may take 30&ndash;60 seconds and can make
            the browser unresponsive.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Use the <strong>Root Type</strong> selector in settings to pick a
            subset, or click below to render the full graph anyway.
          </Typography>
          <Button
            variant="contained"
            color="primary"
            style={{ color: 'white' }}
            onClick={() => this.setState({ forceRender: true }, () => {
              this._renderSvgAsync(this.props.typeGraph, this.props.displayOptions);
            })}
          >
            Render full schema ({nodeCount} types)
          </Button>
        </div>
      );
    }

    return (
      <>
        <div ref="viewport" className="viewport" />
        {isLoading && <LoadingAnimation />}
      </>
    );
  }

  resize() {
    const { svgViewport } = this.state;
    if (svgViewport) {
      svgViewport.resize();
    }
  }

  focusNode(id: string) {
    const { svgViewport } = this.state;
    if (svgViewport) {
      svgViewport.focusElement(id);
    }
  }

  _cleanupSvgViewport() {
    const { svgViewport } = this.state;
    if (svgViewport) {
      svgViewport.destroy();
    }
  }
}
