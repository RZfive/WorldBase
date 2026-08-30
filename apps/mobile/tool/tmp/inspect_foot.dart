import 'package:markdown/markdown.dart' as md;
void p(md.Node n,[int d=0]) { print('${'  '*d}${n.runtimeType} ${n is md.Element ? n.tag+' '+n.attributes.toString() : n.textContent}'); if(n is md.Element) n.children?.forEach((x)=>p(x,d+1)); }
void main(){final d=md.Document(extensionSet: md.ExtensionSet.gitHubFlavored); for(final n in d.parse('ref[^note]\n\n[^note]: detail')) p(n);}
