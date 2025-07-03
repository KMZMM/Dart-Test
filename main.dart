import 'dart:convert';

import 'package:http/http.dart' as http;
const String HTTP_URL = "https://randomuser.me/api/?results=20";
void main()async{
  http.Response response = await http.get(Uri.parse(HTTP_URL));
  var decodedJson = jsonDecode(response.body)["results"] as List;
  print(decodedJson);
  print("\n");

}